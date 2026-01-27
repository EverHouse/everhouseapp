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
import MemberBillingTab from './admin/MemberBillingTab';
import MemberActivityTab from './admin/MemberActivityTab';

const stripHtml = (html: string) => html?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || '';

interface MemberProfileDrawerProps {
  isOpen: boolean;
  member: MemberProfile | null;
  isAdmin: boolean;
  onClose: () => void;
  onViewAs: (member: MemberProfile) => void;
  onMemberDeleted?: () => void;
  visitorMode?: boolean;
}

interface MemberHistory {
  bookingHistory: any[];
  bookingRequestsHistory: any[];
  eventRsvpHistory: any[];
  wellnessHistory: any[];
  guestPassInfo: any | null;
  guestCheckInsHistory: any[];
  visitHistory: any[];
  pastBookingsCount?: number;
  pastEventsCount?: number;
  pastWellnessCount?: number;
  attendedVisitsCount?: number;
}

interface GuestVisit {
  id: number;
  bookingId: number;
  guestName: string | null;
  guestEmail: string | null;
  visitDate: string;
  startTime: string;
  resourceName: string | null;
}

interface MemberNote {
  id: number;
  memberEmail: string;
  content: string;
  createdBy: string;
  createdByName: string;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CommunicationLog {
  id: number;
  memberEmail: string;
  type: string;
  direction: string;
  subject: string;
  body: string;
  status: string;
  occurredAt: string;
  loggedBy: string;
  loggedByName: string;
  createdAt: string;
}

type TabType = 'overview' | 'billing' | 'activity' | 'notes' | 'communications';

const TABS: { id: TabType; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'billing', label: 'Billing', icon: 'payments' },
  { id: 'activity', label: 'Activity', icon: 'history' },
  { id: 'notes', label: 'Notes', icon: 'sticky_note_2' },
  { id: 'communications', label: 'Comms', icon: 'chat' },
];

const formatDatePacific = (dateStr: string | null | undefined): string => {
  if (!dateStr) return '';
  try {
    // For date-only strings (YYYY-MM-DD), append noon time to avoid UTC midnight timezone shift
    const normalizedDate = dateStr.includes('T') ? dateStr : `${dateStr}T12:00:00`;
    const d = new Date(normalizedDate);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
  } catch {
    return dateStr;
  }
};

const formatDateTimePacific = (dateStr: string | null | undefined): string => {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
  } catch {
    return dateStr;
  }
};

const formatTime12Hour = (timeStr: string): string => {
  if (!timeStr) return '';
  const [hours, minutes] = timeStr.substring(0, 5).split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${period}`;
};

const VISITOR_TABS: TabType[] = ['billing', 'activity', 'communications', 'notes'];

const MemberProfileDrawer: React.FC<MemberProfileDrawerProps> = ({ isOpen, member, isAdmin, onClose, onViewAs, onMemberDeleted, visitorMode = false }) => {
  const { effectiveTheme } = useTheme();
  const { setDrawerOpen } = useBottomNav();
  const isDark = effectiveTheme === 'dark';
  
  useEffect(() => {
    setDrawerOpen(isOpen);
    return () => setDrawerOpen(false);
  }, [isOpen, setDrawerOpen]);
  
  // iOS PWA fix: temporarily set body background to match drawer when open
  // This covers any gap in the safe area that iOS doesn't let fixed elements fill
  useEffect(() => {
    if (isOpen) {
      const originalBg = document.body.style.backgroundColor;
      document.body.style.backgroundColor = isDark ? '#1a1d15' : '#ffffff';
      return () => {
        document.body.style.backgroundColor = originalBg;
      };
    }
  }, [isOpen, isDark]);
  
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
      const [historyRes, notesRes, commsRes, guestsRes, purchasesRes] = await Promise.all([
        fetch(`/api/members/${encodeURIComponent(member.email)}/history`, { credentials: 'include' }),
        fetch(`/api/members/${encodeURIComponent(member.email)}/notes`, { credentials: 'include' }),
        fetch(`/api/members/${encodeURIComponent(member.email)}/communications`, { credentials: 'include' }),
        fetch(`/api/members/${encodeURIComponent(member.email)}/guests`, { credentials: 'include' }),
        fetch(`/api/members/${encodeURIComponent(member.email)}/unified-purchases`, { credentials: 'include' }),
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
    } catch (err) {
      console.error('Failed to fetch member data:', err);
    } finally {
      setIsLoading(false);
    }
  }, [member?.email]);

  useEffect(() => {
    if (isOpen && member) {
      setActiveTab('overview');
      setLinkedEmails(member.manuallyLinkedEmails || []);
      fetchMemberData();
    }
  }, [isOpen, member, fetchMemberData]);

  useScrollLock(isOpen, onClose);

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

  const handleUpdateBookingStatus = async (bookingId: number | string, newStatus: 'attended' | 'no_show' | 'cancelled') => {
    setUpdatingBookingId(bookingId);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/checkin`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: newStatus })
      });
      if (res.ok) {
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
    } catch (err) {
      console.error('Failed to update booking status:', err);
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
        const hasAddress = member?.streetAddress || member?.city || member?.state || member?.zipCode;
        const addressParts = [member?.streetAddress, member?.city, member?.state, member?.zipCode].filter(Boolean);
        const formattedAddress = addressParts.length > 0 
          ? (member?.streetAddress ? member.streetAddress + ', ' : '') + 
            [member?.city, member?.state].filter(Boolean).join(', ') + 
            (member?.zipCode ? ' ' + member.zipCode : '')
          : null;
        
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="material-symbols-outlined text-lg text-brand-green">event_note</span>
                  <span className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{bookingsCount}</span>
                </div>
                <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Total Bookings</p>
              </div>
              <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="material-symbols-outlined text-lg text-purple-500">celebration</span>
                  <span className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{eventsCount}</span>
                </div>
                <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Event RSVPs</p>
              </div>
              <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="material-symbols-outlined text-lg text-pink-500">spa</span>
                  <span className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{wellnessCount}</span>
                </div>
                <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Wellness Classes</p>
              </div>
              <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="material-symbols-outlined text-lg text-emerald-500">check_circle</span>
                  <span className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{visitsCount}</span>
                </div>
                <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Attended Visits</p>
              </div>
            </div>

            {(member?.dateOfBirth || member?.companyName || hasAddress || member?.emailOptIn !== null || member?.smsOptIn !== null) && (
              <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                <h4 className={`text-sm font-bold mb-3 flex items-center gap-2 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                  <span className="material-symbols-outlined text-[18px]">info</span>
                  Personal Information
                </h4>
                <div className="space-y-2">
                  {member?.dateOfBirth && (
                    <div className="flex items-center gap-2">
                      <span className={`material-symbols-outlined text-[16px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>cake</span>
                      <span className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        {formatDatePacific(member.dateOfBirth)}
                      </span>
                    </div>
                  )}
                  {member?.companyName && (
                    <div className="flex items-center gap-2">
                      <span className={`material-symbols-outlined text-[16px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>business</span>
                      <span className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        {member.companyName}
                      </span>
                    </div>
                  )}
                  {formattedAddress && (
                    <div className="flex items-start gap-2">
                      <span className={`material-symbols-outlined text-[16px] mt-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>location_on</span>
                      <span className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        {formattedAddress}
                      </span>
                    </div>
                  )}
                  {(member?.emailOptIn !== null || member?.smsOptIn !== null) && (
                    <div className="flex items-center gap-4 pt-1">
                      {member?.emailOptIn !== null && (
                        <div className="flex items-center gap-1.5">
                          <span className={`material-symbols-outlined text-[14px] ${member.emailOptIn ? 'text-green-500' : 'text-gray-400'}`}>
                            {member.emailOptIn ? 'check_circle' : 'cancel'}
                          </span>
                          <span className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Email</span>
                        </div>
                      )}
                      {member?.smsOptIn !== null && (
                        <div className="flex items-center gap-1.5">
                          <span className={`material-symbols-outlined text-[14px] ${member.smsOptIn ? 'text-green-500' : 'text-gray-400'}`}>
                            {member.smsOptIn ? 'check_circle' : 'cancel'}
                          </span>
                          <span className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>SMS</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
            
            {isAdmin && linkedEmails.length > 0 && (
              <div className={`mt-6 p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                <h4 className={`text-sm font-bold mb-3 flex items-center gap-2 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                  <span className="material-symbols-outlined text-[18px]">link</span>
                  Trackman Linked Emails
                </h4>
                <div className="space-y-2">
                  {linkedEmails.map(email => (
                    <div key={email} className={`flex items-center justify-between px-3 py-2 rounded-lg ${isDark ? 'bg-white/5' : 'bg-white'}`}>
                      <span className={`text-sm font-mono truncate ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{email}</span>
                      <button
                        onClick={() => handleRemoveLinkedEmail(email)}
                        disabled={removingEmail === email}
                        className="text-red-500 hover:text-red-600 p-1 disabled:opacity-50"
                        aria-label="Remove linked email"
                      >
                        {removingEmail === email ? (
                          <span className="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>
                        ) : (
                          <span className="material-symbols-outlined text-[18px]">close</span>
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );

      case 'communications':
        return (
          <div className="space-y-4">
            <button
              onClick={() => setShowAddComm(!showAddComm)}
              className="w-full py-2 px-4 rounded-xl bg-brand-green text-white font-medium flex items-center justify-center gap-2 hover:opacity-90 transition-opacity"
            >
              <span className="material-symbols-outlined text-lg">add</span>
              Log Communication
            </button>

            {showAddComm && (
              <div className={`p-4 rounded-xl ${isDark ? 'bg-white/10' : 'bg-gray-100'}`}>
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <select
                      value={newCommType}
                      onChange={(e) => setNewCommType(e.target.value)}
                      className={`flex-1 px-3 py-2 rounded-lg text-sm ${isDark ? 'bg-white/10 text-white border-white/20' : 'bg-white text-gray-900 border-gray-200'} border`}
                    >
                      <option value="email">Email</option>
                      <option value="call">Call</option>
                      <option value="meeting">Meeting</option>
                      <option value="note">Note</option>
                      <option value="sms">SMS</option>
                    </select>
                    <select
                      value={newCommDirection}
                      onChange={(e) => setNewCommDirection(e.target.value)}
                      className={`flex-1 px-3 py-2 rounded-lg text-sm ${isDark ? 'bg-white/10 text-white border-white/20' : 'bg-white text-gray-900 border-gray-200'} border`}
                    >
                      <option value="outbound">Outbound</option>
                      <option value="inbound">Inbound</option>
                    </select>
                  </div>
                  <input
                    type="text"
                    placeholder="Subject"
                    value={newCommSubject}
                    onChange={(e) => setNewCommSubject(e.target.value)}
                    className={`w-full px-3 py-2 rounded-lg text-sm ${isDark ? 'bg-white/10 text-white border-white/20 placeholder-gray-500' : 'bg-white text-gray-900 border-gray-200'} border`}
                  />
                  <textarea
                    placeholder="Details (optional)"
                    value={newCommBody}
                    onChange={(e) => setNewCommBody(e.target.value)}
                    rows={3}
                    className={`w-full px-3 py-2 rounded-lg text-sm resize-none ${isDark ? 'bg-white/10 text-white border-white/20 placeholder-gray-500' : 'bg-white text-gray-900 border-gray-200'} border`}
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowAddComm(false)}
                      className={`flex-1 py-2 px-4 rounded-lg font-medium ${isDark ? 'bg-white/10 text-white' : 'bg-gray-200 text-gray-700'}`}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleAddCommunication}
                      disabled={isAddingComm || !newCommSubject.trim()}
                      className="flex-1 py-2 px-4 rounded-lg bg-brand-green text-white font-medium disabled:opacity-50"
                    >
                      {isAddingComm ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {communications.length === 0 ? (
              <EmptyState icon="chat" message="No communications logged yet" />
            ) : (
              <div className="space-y-3">
                {communications.map((comm) => (
                  <div key={comm.id} className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`material-symbols-outlined text-lg ${
                            comm.type === 'email' ? 'text-blue-500' :
                            comm.type === 'call' ? 'text-green-500' :
                            comm.type === 'meeting' ? 'text-purple-500' :
                            comm.type === 'sms' ? 'text-orange-500' : 'text-gray-500'
                          }`}>
                            {comm.type === 'email' ? 'mail' :
                             comm.type === 'call' ? 'call' :
                             comm.type === 'meeting' ? 'groups' :
                             comm.type === 'sms' ? 'sms' : 'note'}
                          </span>
                          <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>{comm.subject}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${isDark ? 'bg-white/10 text-gray-400' : 'bg-gray-200 text-gray-600'}`}>
                            {comm.direction}
                          </span>
                        </div>
                        {comm.body && <p className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{stripHtml(comm.body)}</p>}
                        <p className={`text-[10px] mt-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
                          {formatDateTimePacific(comm.occurredAt)} · {comm.loggedByName}
                        </p>
                      </div>
                      <button
                        onClick={() => handleDeleteCommunication(comm.id)}
                        className="text-red-500 hover:text-red-600 p-1"
                      >
                        <span className="material-symbols-outlined text-[18px]">delete</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );

      case 'notes':
        return (
          <div className="space-y-4">
            <div className={`p-4 rounded-xl ${isDark ? 'bg-white/10' : 'bg-gray-100'}`}>
              <textarea
                placeholder="Add a note about this member..."
                value={newNoteContent}
                onChange={(e) => setNewNoteContent(e.target.value)}
                rows={3}
                className={`w-full px-3 py-2 rounded-lg text-sm resize-none ${isDark ? 'bg-white/10 text-white border-white/20 placeholder-gray-500' : 'bg-white text-gray-900 border-gray-200'} border`}
              />
              <div className="flex items-center justify-between mt-2">
                <label className={`flex items-center gap-2 text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  <input
                    type="checkbox"
                    checked={newNotePinned}
                    onChange={(e) => setNewNotePinned(e.target.checked)}
                    className="rounded"
                  />
                  Pin this note
                </label>
                <button
                  onClick={handleAddNote}
                  disabled={isAddingNote || !newNoteContent.trim()}
                  className="py-2 px-4 rounded-lg bg-brand-green text-white font-medium text-sm disabled:opacity-50"
                >
                  {isAddingNote ? 'Adding...' : 'Add Note'}
                </button>
              </div>
            </div>

            {notes.length === 0 ? (
              <EmptyState icon="sticky_note_2" message="No notes yet" />
            ) : (
              <div className="space-y-3">
                {notes.map((note) => (
                  <div key={note.id} className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'} ${note.isPinned ? 'ring-2 ring-yellow-500/50' : ''}`}>
                    {editingNoteId === note.id ? (
                      <div className="space-y-2">
                        <textarea
                          value={editingNoteContent}
                          onChange={(e) => setEditingNoteContent(e.target.value)}
                          rows={3}
                          className={`w-full px-3 py-2 rounded-lg text-sm resize-none ${isDark ? 'bg-white/10 text-white border-white/20' : 'bg-white text-gray-900 border-gray-200'} border`}
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => { setEditingNoteId(null); setEditingNoteContent(''); }}
                            className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium ${isDark ? 'bg-white/10 text-white' : 'bg-gray-200 text-gray-700'}`}
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => handleUpdateNote(note.id, editingNoteContent, note.isPinned)}
                            className="flex-1 py-2 px-3 rounded-lg bg-brand-green text-white text-sm font-medium"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            {note.isPinned && (
                              <span className="material-symbols-outlined text-yellow-500 text-sm mb-1">push_pin</span>
                            )}
                            <p className={`text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>{note.content}</p>
                            <p className={`text-[10px] mt-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
                              {formatDateTimePacific(note.createdAt)} · {note.createdByName}
                            </p>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleUpdateNote(note.id, note.content, !note.isPinned)}
                              className={`p-1 ${note.isPinned ? 'text-yellow-500' : isDark ? 'text-gray-400' : 'text-gray-500'}`}
                              title={note.isPinned ? 'Unpin' : 'Pin'}
                            >
                              <span className="material-symbols-outlined text-[18px]">push_pin</span>
                            </button>
                            <button
                              onClick={() => { setEditingNoteId(note.id); setEditingNoteContent(note.content); }}
                              className={`p-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}
                            >
                              <span className="material-symbols-outlined text-[18px]">edit</span>
                            </button>
                            <button
                              onClick={() => handleDeleteNote(note.id)}
                              className="text-red-500 hover:text-red-600 p-1"
                            >
                              <span className="material-symbols-outlined text-[18px]">delete</span>
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );

      case 'billing':
        return (
          <div className="space-y-4">
            <MemberBillingTab 
              memberEmail={member.email} 
              memberId={member.id} 
              currentTier={displayedTier}
              onTierUpdate={(newTier) => setDisplayedTier(newTier)}
              guestPassInfo={history?.guestPassInfo}
              guestHistory={guestHistory}
              guestCheckInsHistory={history?.guestCheckInsHistory}
              purchases={purchases}
            />
          </div>
        );

      case 'activity':
        return (
          <MemberActivityTab
            memberEmail={member.email}
            bookingHistory={filteredBookingHistory}
            bookingRequestsHistory={filteredBookingRequestsHistory}
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
    <div className={`fixed inset-0 ${isDark ? 'dark' : ''}`} style={{ zIndex: 'var(--z-modal)' }}>
      <div 
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300"
        onClick={onClose}
      />
      
      <div 
        className={`fixed right-0 top-0 bottom-0 w-full max-w-xl ${isDark ? 'bg-[#1a1d15]' : 'bg-white'} shadow-2xl transform transition-transform duration-300 flex flex-col`}
        style={{ 
          animation: 'slideInRight 0.4s var(--spring-bounce)',
          paddingTop: 'env(safe-area-inset-top, 0px)'
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
                {member.tags?.map(tag => (
                  <TagBadge key={tag} tag={tag} size="sm" />
                ))}
              </div>
            </div>
            <button
              onClick={onClose}
              className={`p-2 rounded-full transition-colors ${isDark ? 'hover:bg-white/10 text-gray-300' : 'hover:bg-gray-100 text-gray-600'}`}
            >
              <span className="material-symbols-outlined">close</span>
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
            {/* System IDs section */}
            <div className="flex items-center gap-3 flex-wrap text-xs mt-1">
              {member.mindbodyClientId && (
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
                onClick={() => setShowDeleteModal(true)}
                className="py-2.5 px-4 rounded-xl bg-red-600 text-white font-medium flex items-center justify-center gap-2 hover:bg-red-700 transition-colors"
                title="Permanently delete member (for testing)"
              >
                <span className="material-symbols-outlined text-lg">delete_forever</span>
              </button>
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
                      <span className="material-symbols-outlined text-lg">link</span>
                    )}
                  </button>
                </div>
              </div>
              <button
                onClick={() => setShowDeleteModal(true)}
                className="w-full py-2.5 px-4 rounded-xl bg-red-600/10 text-red-600 dark:text-red-400 font-medium flex items-center justify-center gap-2 hover:bg-red-600/20 transition-colors"
                title="Permanently delete visitor"
              >
                <span className="material-symbols-outlined text-lg">delete_forever</span>
                Delete Visitor
              </button>
            </div>
          )}

          {isAdmin && !visitorMode && member.membershipStatus && ['terminated', 'cancelled', 'canceled', 'frozen', 'inactive', 'past_due', 'suspended'].includes(member.membershipStatus.toLowerCase()) && (
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
          className="flex-1 overflow-y-auto p-4 sm:p-6"
          style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom, 0px))' }}
        >
          {renderContent()}
        </div>
      </div>
    </div>
  );

  return createPortal(drawerContent, document.body);
};

const EmptyState: React.FC<{ icon: string; message: string }> = ({ icon, message }) => {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <span className={`material-symbols-outlined text-4xl mb-3 ${isDark ? 'text-white/20' : 'text-gray-300'}`}>{icon}</span>
      <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{message}</p>
    </div>
  );
};

export default MemberProfileDrawer;

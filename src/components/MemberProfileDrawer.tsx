import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../contexts/ThemeContext';
import TierBadge from './TierBadge';
import TagBadge from './TagBadge';
import { formatPhoneNumber } from '../utils/formatting';
import { getMemberStatusColor, getMemberStatusLabel } from '../utils/statusColors';
import type { MemberProfile } from '../types/data';

interface MemberProfileDrawerProps {
  isOpen: boolean;
  member: MemberProfile | null;
  isAdmin: boolean;
  onClose: () => void;
  onViewAs: (member: MemberProfile) => void;
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

type TabType = 'overview' | 'bookings' | 'events' | 'wellness' | 'visits' | 'guest-passes' | 'communications' | 'notes';

const TABS: { id: TabType; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'bookings', label: 'Bookings', icon: 'event_note' },
  { id: 'events', label: 'Events', icon: 'celebration' },
  { id: 'wellness', label: 'Wellness', icon: 'spa' },
  { id: 'visits', label: 'Visits', icon: 'check_circle' },
  { id: 'guest-passes', label: 'Guests', icon: 'group_add' },
  { id: 'communications', label: 'Comms', icon: 'chat' },
  { id: 'notes', label: 'Notes', icon: 'sticky_note_2' },
];

const formatDatePacific = (dateStr: string | null | undefined): string => {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
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

const MemberProfileDrawer: React.FC<MemberProfileDrawerProps> = ({ isOpen, member, isAdmin, onClose, onViewAs }) => {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [isLoading, setIsLoading] = useState(false);
  const [history, setHistory] = useState<MemberHistory | null>(null);
  const [notes, setNotes] = useState<MemberNote[]>([]);
  const [communications, setCommunications] = useState<CommunicationLog[]>([]);
  const [guestHistory, setGuestHistory] = useState<GuestVisit[]>([]);
  const [linkedEmails, setLinkedEmails] = useState<string[]>([]);
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

  const fetchMemberData = useCallback(async () => {
    if (!member?.email) return;
    setIsLoading(true);
    try {
      const [historyRes, notesRes, commsRes, guestsRes] = await Promise.all([
        fetch(`/api/members/${encodeURIComponent(member.email)}/history`, { credentials: 'include' }),
        fetch(`/api/members/${encodeURIComponent(member.email)}/notes`, { credentials: 'include' }),
        fetch(`/api/members/${encodeURIComponent(member.email)}/communications`, { credentials: 'include' }),
        fetch(`/api/members/${encodeURIComponent(member.email)}/guests`, { credentials: 'include' }),
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

  useEffect(() => {
    if (!isOpen) return;

    const scrollY = window.scrollY;
    document.documentElement.classList.add('overflow-hidden');
    document.body.classList.add('overflow-hidden');
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.overscrollBehavior = 'none';

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.documentElement.classList.remove('overflow-hidden');
      document.body.classList.remove('overflow-hidden');
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      document.body.style.overscrollBehavior = '';
      window.scrollTo(0, scrollY);
    };
  }, [isOpen, onClose]);

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
                        title="Remove linked email"
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

      case 'bookings':
        const allBookings = [
          ...filteredBookingHistory.map((b: any) => ({ ...b, source: 'confirmed' })),
          ...filteredBookingRequestsHistory.map((b: any) => ({ ...b, source: 'request' }))
        ].sort((a, b) => new Date(b.bookingDate || b.requestDate).getTime() - new Date(a.bookingDate || a.requestDate).getTime());
        
        if (allBookings.length === 0) {
          return <EmptyState icon="event_note" message="No booking history found" />;
        }
        return (
          <div className="space-y-3">
            {allBookings.map((booking: any, idx: number) => {
              const canUpdateStatus = booking.status === 'approved' || booking.status === 'confirmed';
              const isUpdating = updatingBookingId === booking.id;
              
              return (
                <div key={`${booking.source}-${booking.id}-${idx}`} className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                          {booking.resourceName || booking.resourceType || 'Booking'}
                        </span>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                          booking.status === 'attended' ? 'bg-green-100 text-green-700' :
                          booking.status === 'approved' || booking.status === 'confirmed' ? 'bg-blue-100 text-blue-700' :
                          booking.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                          booking.status === 'no_show' ? 'bg-orange-100 text-orange-700' :
                          booking.status === 'cancelled' || booking.status === 'declined' ? 'bg-red-100 text-red-700' :
                          'bg-gray-100 text-gray-700'
                        }`}>
                          {booking.status === 'no_show' ? 'No Show' : booking.status}
                        </span>
                      </div>
                      <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                        {formatDatePacific(booking.bookingDate || booking.requestDate)} · {formatTime12Hour(booking.startTime)} - {formatTime12Hour(booking.endTime)}
                      </p>
                      {booking.notes && <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-500'} line-clamp-1`}>{booking.notes}</p>}
                    </div>
                    {canUpdateStatus && (
                      <div className="flex gap-1.5 shrink-0">
                        <button
                          onClick={() => handleUpdateBookingStatus(booking.id, 'attended')}
                          disabled={isUpdating}
                          className={`px-2 py-1 rounded-lg text-[10px] font-medium transition-colors ${
                            isUpdating
                              ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                              : 'bg-green-100 text-green-700 hover:bg-green-200'
                          }`}
                          title="Mark as Attended"
                        >
                          {isUpdating ? (
                            <span className="material-symbols-outlined text-[12px] animate-spin">progress_activity</span>
                          ) : (
                            'Attended'
                          )}
                        </button>
                        <button
                          onClick={() => handleUpdateBookingStatus(booking.id, 'no_show')}
                          disabled={isUpdating}
                          className={`px-2 py-1 rounded-lg text-[10px] font-medium transition-colors ${
                            isUpdating
                              ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                              : 'bg-orange-100 text-orange-700 hover:bg-orange-200'
                          }`}
                          title="Mark as No Show"
                        >
                          No Show
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );

      case 'events':
        if (!history?.eventRsvpHistory?.length) {
          return <EmptyState icon="celebration" message="No event RSVPs found" />;
        }
        return (
          <div className="space-y-3">
            {history.eventRsvpHistory.map((rsvp: any) => (
              <div key={rsvp.id} className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>{rsvp.eventTitle}</span>
                      {rsvp.checkedIn && <span className="material-symbols-outlined text-green-500 text-sm">check_circle</span>}
                    </div>
                    <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                      {formatDatePacific(rsvp.eventDate)} · {rsvp.eventLocation}
                    </p>
                    {rsvp.ticketClass && <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>Ticket: {rsvp.ticketClass}</p>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        );

      case 'wellness':
        if (!history?.wellnessHistory?.length) {
          return <EmptyState icon="spa" message="No wellness class enrollments found" />;
        }
        return (
          <div className="space-y-3">
            {history.wellnessHistory.map((enrollment: any) => (
              <div key={enrollment.id} className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>{enrollment.classTitle}</span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                      enrollment.status === 'enrolled' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'
                    }`}>
                      {enrollment.status}
                    </span>
                  </div>
                  <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                    {formatDatePacific(enrollment.classDate)} · {enrollment.classTime}
                  </p>
                  {enrollment.instructor && <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>Instructor: {enrollment.instructor}</p>}
                </div>
              </div>
            ))}
          </div>
        );

      case 'visits':
        if (!history?.visitHistory?.length) {
          return <EmptyState icon="check_circle" message="No attended visits found" />;
        }
        return (
          <div className="space-y-3">
            {history.visitHistory.map((visit: any) => (
              <div key={visit.id} className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="material-symbols-outlined text-green-500 text-lg">check_circle</span>
                  <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>{visit.resourceName || 'Visit'}</span>
                </div>
                <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  {formatDatePacific(visit.bookingDate)} · {formatTime12Hour(visit.startTime)} - {formatTime12Hour(visit.endTime)}
                </p>
                {visit.guestCount > 0 && <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>+{visit.guestCount} guest(s)</p>}
              </div>
            ))}
          </div>
        );

      case 'guest-passes':
        return (
          <div className="space-y-4">
            {history?.guestPassInfo && (
              <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                <h4 className={`text-sm font-semibold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>Guest Pass Balance</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{history.guestPassInfo.remainingPasses || 0}</p>
                    <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Remaining</p>
                  </div>
                  <div>
                    <p className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{history.guestPassInfo.totalUsed || 0}</p>
                    <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Used</p>
                  </div>
                </div>
              </div>
            )}
            
            {guestHistory.length > 0 && (
              <div>
                <h4 className={`text-sm font-semibold mb-3 ${isDark ? 'text-white' : 'text-gray-900'}`}>Guests Brought to Bookings</h4>
                <div className="space-y-3">
                  {guestHistory.map((guest) => (
                    <div key={guest.id} className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="material-symbols-outlined text-brand-green text-lg">person</span>
                        <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>{guest.guestName || 'Guest'}</span>
                      </div>
                      <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                        {formatDatePacific(guest.visitDate)} · {formatTime12Hour(guest.startTime)}
                        {guest.resourceName && ` · ${guest.resourceName}`}
                      </p>
                      {guest.guestEmail && (
                        <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>{guest.guestEmail}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {history?.guestCheckInsHistory?.length ? (
              <div>
                <h4 className={`text-sm font-semibold mb-3 ${isDark ? 'text-white' : 'text-gray-900'}`}>Guest Check-In History</h4>
                <div className="space-y-3">
                  {history.guestCheckInsHistory.map((checkIn: any) => (
                    <div key={checkIn.id} className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="material-symbols-outlined text-purple-500 text-lg">person</span>
                        <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>{checkIn.guestName || 'Guest'}</span>
                      </div>
                      <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                        {formatDatePacific(checkIn.checkInDate)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            
            {!history?.guestPassInfo && guestHistory.length === 0 && !history?.guestCheckInsHistory?.length && (
              <EmptyState icon="group_add" message="No guests recorded yet" />
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
                        {comm.body && <p className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{comm.body}</p>}
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

      default:
        return null;
    }
  };

  const drawerContent = (
    <div className={`fixed inset-0 ${isDark ? 'dark' : ''}`} style={{ zIndex: 'var(--z-drawer)' }}>
      <div 
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300"
        onClick={onClose}
      />
      
      <div 
        className={`fixed inset-y-0 right-0 w-full max-w-xl ${isDark ? 'bg-[#1a1d15]' : 'bg-white'} shadow-2xl transform transition-transform duration-300 ease-out flex flex-col`}
        style={{ animation: 'slideInRight 0.3s ease-out' }}
      >
        <div className={`flex-shrink-0 p-4 sm:p-6 border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <h2 className={`text-xl sm:text-2xl font-bold truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>{member.name}</h2>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <TierBadge tier={member.tier} size="md" />
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
              {member.mindbodyClientId && (
                <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>
                  MindBody: {member.mindbodyClientId}
                </span>
              )}
              <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>
                {visitsCount} lifetime visits
              </span>
              {member.joinDate && (
                <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>
                  Joined {formatDatePacific(member.joinDate)}
                </span>
              )}
            </div>
          </div>

          {isAdmin && (
            <button
              onClick={() => onViewAs(member)}
              className="mt-4 w-full py-2.5 px-4 rounded-xl bg-brand-green text-white font-medium flex items-center justify-center gap-2 hover:opacity-90 transition-opacity"
            >
              <span className="material-symbols-outlined text-lg">visibility</span>
              View As This Member
            </button>
          )}
        </div>

        <div className={`flex-shrink-0 border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
          <div className="flex overflow-x-auto scrollbar-hide">
            {TABS.map((tab) => (
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

        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
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

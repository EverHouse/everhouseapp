import React, { useState, useEffect, useRef } from 'react';
import { usePageReady } from '../../../contexts/PageReadyContext';
import { useData } from '../../../contexts/DataContext';
import { useToast } from '../../../components/Toast';
import { formatDateTimePacific, formatDateDisplayWithDay } from '../../../utils/dateUtils';
import WalkingGolferSpinner from '../../../components/WalkingGolferSpinner';
import ModalShell from '../../../components/ModalShell';
import PullToRefresh from '../../../components/PullToRefresh';
import ManagePlayersModal from '../../../components/admin/ManagePlayersModal';
import RosterManager from '../../../components/booking/RosterManager';

const formatTime12Hour = (time: string | null | undefined): string => {
  if (!time) return '';
  const [hours, minutes] = time.split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
};

const ITEMS_PER_PAGE = 20;

const formatImportLabel = (filename: string, createdAt?: string): string => {
  if (!filename) return 'Trackman Import';
  
  // Try to extract date range from common Trackman export filename patterns
  // Patterns like: "2026-02-01_to_2026-02-28" or "Feb01-Feb28" or just dates
  const dateRangeMatch = filename.match(/(\d{4}-\d{2}-\d{2})[_\s-]*(to|thru|through)?[_\s-]*(\d{4}-\d{2}-\d{2})?/i);
  
  if (dateRangeMatch) {
    const [, startDate, , endDate] = dateRangeMatch;
    const formatShort = (d: string) => {
      const date = new Date(d + 'T12:00:00');
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };
    const startYear = startDate.substring(0, 4);
    
    if (endDate) {
      const endYear = endDate.substring(0, 4);
      if (startYear === endYear) {
        return `${formatShort(startDate)} - ${formatShort(endDate)}, ${startYear}`;
      }
      return `${formatShort(startDate)}, ${startYear} - ${formatShort(endDate)}, ${endYear}`;
    }
    return `${formatShort(startDate)}, ${startYear}`;
  }
  
  // If no date pattern found, try to clean up the filename
  // Remove file extension and common prefixes
  let cleaned = filename.replace(/\.(csv|xlsx?)$/i, '').replace(/^(trackman[_\s-]*|import[_\s-]*)/i, '');
  
  // If it's still a technical-looking name, just show "Trackman Import"
  if (!cleaned || cleaned.length > 40 || /^[a-f0-9-]{20,}$/i.test(cleaned)) {
    return 'Trackman Import';
  }
  
  // Capitalize and clean up underscores/hyphens
  return cleaned.replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim() || 'Trackman Import';
};

const TrackmanTab: React.FC = () => {
  const pageReadyContext = usePageReady();
  const dataContext = useData();
  const toastContext = useToast();
  
  // Defensive checks for context availability
  const setPageReady = pageReadyContext?.setPageReady || (() => {});
  const actualUser = dataContext?.actualUser;
  const showToast = toastContext?.showToast || (() => {});
  const [unmatchedBookings, setUnmatchedBookings] = useState<any[]>([]);
  const [unmatchedTotalCount, setUnmatchedTotalCount] = useState<number>(0);
  const [unmatchedPage, setUnmatchedPage] = useState(1);
  const [matchedBookings, setMatchedBookings] = useState<any[]>([]);
  const [matchedTotalCount, setMatchedTotalCount] = useState<number>(0);
  const [matchedPage, setMatchedPage] = useState(1);
  const [showMatchedBookings, setShowMatchedBookings] = useState(false);
  const [needsPlayersBookings, setNeedsPlayersBookings] = useState<any[]>([]);
  const [needsPlayersTotalCount, setNeedsPlayersTotalCount] = useState<number>(0);
  const [needsPlayersPage, setNeedsPlayersPage] = useState(1);
  const [needsPlayersSearchQuery, setNeedsPlayersSearchQuery] = useState('');
  const [potentialMatches, setPotentialMatches] = useState<any[]>([]);
  const [potentialMatchesTotalCount, setPotentialMatchesTotalCount] = useState<number>(0);
  const [requiresReviewBookings, setRequiresReviewBookings] = useState<any[]>([]);
  const [requiresReviewTotalCount, setRequiresReviewTotalCount] = useState<number>(0);
  const [fuzzyMatchModal, setFuzzyMatchModal] = useState<{ booking: any; matches: any[]; isLoading: boolean; selectedEmail: string } | null>(null);
  const [importRuns, setImportRuns] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  const [resolveModal, setResolveModal] = useState<{ booking: any; memberEmail: string } | null>(null);
  const [editMatchedModal, setEditMatchedModal] = useState<{ booking: any; newMemberEmail: string } | null>(null);
  const [managePlayersModal, setManagePlayersModal] = useState<{ booking: any } | null>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [editSearchQuery, setEditSearchQuery] = useState('');
  const [unmatchedSearchQuery, setUnmatchedSearchQuery] = useState('');
  const [matchedSearchQuery, setMatchedSearchQuery] = useState('');
  const [fuzzySearchQuery, setFuzzySearchQuery] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [isLinkingMatch, setIsLinkingMatch] = useState<number | null>(null);
  const [viewDetailBooking, setViewDetailBooking] = useState<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const unmatchedSectionRef = useRef<HTMLDivElement>(null);
  const matchedSectionRef = useRef<HTMLDivElement>(null);
  const needsPlayersSectionRef = useRef<HTMLDivElement>(null);

  const fetchUnmatched = async (page: number, search?: string) => {
    try {
      const offset = (page - 1) * ITEMS_PER_PAGE;
      const cacheBuster = `_t=${Date.now()}`;
      const searchParam = search ? `&search=${encodeURIComponent(search)}` : '';
      const res = await fetch(`/api/admin/trackman/unmatched?resolved=false&limit=${ITEMS_PER_PAGE}&offset=${offset}${searchParam}&${cacheBuster}`, { credentials: 'include' });
      if (res.ok) {
        const result = await res.json();
        setUnmatchedBookings(result.data || []);
        setUnmatchedTotalCount(result.totalCount || 0);
      }
    } catch (err) {
      console.error('Failed to fetch unmatched bookings:', err);
    }
  };

  const fetchMatched = async (page: number, search?: string) => {
    try {
      const offset = (page - 1) * ITEMS_PER_PAGE;
      const cacheBuster = `_t=${Date.now()}`;
      const searchParam = search ? `&search=${encodeURIComponent(search)}` : '';
      const res = await fetch(`/api/admin/trackman/matched?limit=${ITEMS_PER_PAGE}&offset=${offset}${searchParam}&${cacheBuster}`, { credentials: 'include' });
      if (res.ok) {
        const result = await res.json();
        setMatchedBookings(result.data || []);
        setMatchedTotalCount(result.totalCount || 0);
      }
    } catch (err) {
      console.error('Failed to fetch matched bookings:', err);
    }
  };

  const fetchNeedsPlayers = async (page: number, search?: string) => {
    try {
      const offset = (page - 1) * ITEMS_PER_PAGE;
      const cacheBuster = `_t=${Date.now()}`;
      const searchParam = search ? `&search=${encodeURIComponent(search)}` : '';
      const res = await fetch(`/api/admin/trackman/needs-players?limit=${ITEMS_PER_PAGE}&offset=${offset}${searchParam}&${cacheBuster}`, { credentials: 'include' });
      if (res.ok) {
        const result = await res.json();
        setNeedsPlayersBookings(result.data || []);
        setNeedsPlayersTotalCount(result.totalCount || 0);
      }
    } catch (err) {
      console.error('Failed to fetch needs-players bookings:', err);
    }
  };

  const fetchPotentialMatches = async () => {
    try {
      const cacheBuster = `_t=${Date.now()}`;
      const res = await fetch(`/api/admin/trackman/potential-matches?${cacheBuster}`, { credentials: 'include' });
      if (res.ok) {
        const result = await res.json();
        setPotentialMatches(result.data || []);
        setPotentialMatchesTotalCount(result.totalCount || 0);
      }
    } catch (err) {
      console.error('Failed to fetch potential matches:', err);
    }
  };

  const fetchRequiresReview = async () => {
    try {
      const cacheBuster = `_t=${Date.now()}`;
      const res = await fetch(`/api/admin/trackman/requires-review?${cacheBuster}`, { credentials: 'include' });
      if (res.ok) {
        const result = await res.json();
        setRequiresReviewBookings(result.data || []);
        setRequiresReviewTotalCount(result.totalCount || 0);
      }
    } catch (err) {
      console.error('Failed to fetch requires-review bookings:', err);
    }
  };

  const handleOpenFuzzyMatchModal = async (booking: any) => {
    setFuzzyMatchModal({ booking, matches: [], isLoading: true, selectedEmail: '' });
    try {
      const res = await fetch(`/api/admin/trackman/fuzzy-matches/${booking.id}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setFuzzyMatchModal(prev => prev ? { ...prev, matches: data.matches || [], isLoading: false } : null);
      } else {
        setFuzzyMatchModal(prev => prev ? { ...prev, isLoading: false } : null);
        showToast('Failed to fetch fuzzy matches', 'error');
      }
    } catch (err) {
      console.error('Failed to fetch fuzzy matches:', err);
      setFuzzyMatchModal(prev => prev ? { ...prev, isLoading: false } : null);
      showToast('Failed to fetch fuzzy matches', 'error');
    }
  };

  const handleResolveFuzzyMatch = async () => {
    if (!fuzzyMatchModal || !fuzzyMatchModal.selectedEmail) return;
    try {
      const res = await fetch(`/api/admin/trackman/unmatched/${fuzzyMatchModal.booking.id}/resolve`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ memberEmail: fuzzyMatchModal.selectedEmail })
      });
      if (res.ok) {
        const data = await res.json();
        setFuzzyMatchModal(null);
        setFuzzySearchQuery('');
        if (data.autoResolved > 0) {
          showToast(`Resolved ${data.resolved} booking(s) (${data.autoResolved} auto-resolved with same name)`, 'success', 5000);
        } else {
          showToast('Booking resolved successfully', 'success');
        }
        await new Promise(resolve => setTimeout(resolve, 300));
        fetchData();
      } else {
        showToast('Failed to resolve booking', 'error');
      }
    } catch (err) {
      console.error('Failed to resolve booking:', err);
      showToast('Failed to resolve booking', 'error');
    }
  };

  const fetchData = async () => {
    try {
      const cacheBuster = `_t=${Date.now()}`;
      const unmatchedOffset = (unmatchedPage - 1) * ITEMS_PER_PAGE;
      const matchedOffset = (matchedPage - 1) * ITEMS_PER_PAGE;
      const needsPlayersOffset = (needsPlayersPage - 1) * ITEMS_PER_PAGE;
      const [unmatchedRes, matchedRes, runsRes, membersRes, needsPlayersRes, potentialMatchesRes, requiresReviewRes] = await Promise.all([
        fetch(`/api/admin/trackman/unmatched?resolved=false&limit=${ITEMS_PER_PAGE}&offset=${unmatchedOffset}&${cacheBuster}`, { credentials: 'include' }),
        fetch(`/api/admin/trackman/matched?limit=${ITEMS_PER_PAGE}&offset=${matchedOffset}&${cacheBuster}`, { credentials: 'include' }),
        fetch(`/api/admin/trackman/import-runs?${cacheBuster}`, { credentials: 'include' }),
        fetch('/api/hubspot/contacts?status=all', { credentials: 'include' }),
        fetch(`/api/admin/trackman/needs-players?limit=${ITEMS_PER_PAGE}&offset=${needsPlayersOffset}&${cacheBuster}`, { credentials: 'include' }),
        fetch(`/api/admin/trackman/potential-matches?${cacheBuster}`, { credentials: 'include' }),
        fetch(`/api/admin/trackman/requires-review?${cacheBuster}`, { credentials: 'include' })
      ]);
      
      if (unmatchedRes.ok) {
        const result = await unmatchedRes.json();
        setUnmatchedBookings(result.data || []);
        setUnmatchedTotalCount(result.totalCount || 0);
      }
      if (matchedRes.ok) {
        const result = await matchedRes.json();
        setMatchedBookings(result.data || []);
        setMatchedTotalCount(result.totalCount || 0);
      }
      if (runsRes.ok) {
        const data = await runsRes.json();
        setImportRuns(data);
      }
      if (membersRes.ok) {
        const data = await membersRes.json();
        const membersArray = Array.isArray(data) ? data : (data?.contacts || []);
        setMembers(membersArray);
      }
      if (needsPlayersRes.ok) {
        const result = await needsPlayersRes.json();
        setNeedsPlayersBookings(result.data || []);
        setNeedsPlayersTotalCount(result.totalCount || 0);
      }
      if (potentialMatchesRes.ok) {
        const result = await potentialMatchesRes.json();
        setPotentialMatches(result.data || []);
        setPotentialMatchesTotalCount(result.totalCount || 0);
      }
      if (requiresReviewRes.ok) {
        const result = await requiresReviewRes.json();
        setRequiresReviewBookings(result.data || []);
        setRequiresReviewTotalCount(result.totalCount || 0);
      }
    } catch (err) {
      console.error('Failed to fetch Trackman data:', err);
    } finally {
      setIsLoading(false);
      setPageReady(true);
    }
  };

  const unmatchedTotalPages = Math.ceil(unmatchedTotalCount / ITEMS_PER_PAGE);
  const matchedTotalPages = Math.ceil(matchedTotalCount / ITEMS_PER_PAGE);
  const needsPlayersTotalPages = Math.ceil(needsPlayersTotalCount / ITEMS_PER_PAGE);

  useEffect(() => {
    fetchData();
  }, []);

  // Debounced search for unmatched bookings
  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      setUnmatchedPage(1);
      fetchUnmatched(1, unmatchedSearchQuery);
    }, 300);
    return () => clearTimeout(debounceTimer);
  }, [unmatchedSearchQuery]);

  // Debounced search for matched bookings
  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      setMatchedPage(1);
      fetchMatched(1, matchedSearchQuery);
    }, 300);
    return () => clearTimeout(debounceTimer);
  }, [matchedSearchQuery]);

  // Debounced search for needs-players bookings
  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      setNeedsPlayersPage(1);
      fetchNeedsPlayers(1, needsPlayersSearchQuery);
    }, 300);
    return () => clearTimeout(debounceTimer);
  }, [needsPlayersSearchQuery]);

  const handleFileUpload = async (file: File) => {
    if (!file.name.endsWith('.csv')) {
      setImportResult({ success: false, error: 'Please upload a CSV file' });
      return;
    }
    
    setIsImporting(true);
    setImportResult(null);
    
    try {
      const formData = new FormData();
      formData.append('file', file);
      
      const res = await fetch('/api/admin/trackman/upload', {
        method: 'POST',
        credentials: 'include',
        body: formData
      });
      const data = await res.json();
      setImportResult(data);
      fetchData();
    } catch (err: any) {
      setImportResult({ success: false, error: err.message });
    } finally {
      setIsImporting(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileUpload(file);
  };

  const handleResolve = async () => {
    if (!resolveModal) return;
    try {
      const res = await fetch(`/api/admin/trackman/unmatched/${resolveModal.booking.id}/resolve`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ memberEmail: resolveModal.memberEmail })
      });
      if (res.ok) {
        const data = await res.json();
        setResolveModal(null);
        if (data.autoResolved > 0) {
          showToast(`Resolved ${data.resolved} booking(s) (${data.autoResolved} auto-resolved with same email)`, 'success', 5000);
        } else {
          showToast('Booking resolved successfully', 'success');
        }
        await new Promise(resolve => setTimeout(resolve, 300));
        fetchData();
      } else {
        showToast('Failed to resolve booking', 'error');
      }
    } catch (err) {
      console.error('Failed to resolve booking:', err);
      showToast('Failed to resolve booking', 'error');
    }
  };

  const handleReassignMatched = async () => {
    if (!editMatchedModal) return;
    try {
      const res = await fetch(`/api/admin/trackman/matched/${editMatchedModal.booking.id}/reassign`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ newMemberEmail: editMatchedModal.newMemberEmail })
      });
      if (res.ok) {
        const data = await res.json();
        setEditMatchedModal(null);
        setEditSearchQuery('');
        showToast(`Booking reassigned from ${data.oldEmail} to ${data.newEmail}`, 'success');
        await new Promise(resolve => setTimeout(resolve, 300));
        fetchData();
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to reassign booking', 'error');
      }
    } catch (err) {
      console.error('Failed to reassign booking:', err);
      showToast('Failed to reassign booking', 'error');
    }
  };

  const handleLinkPotentialMatch = async (unmatchedId: number, appBookingId: number, memberEmail: string) => {
    setIsLinkingMatch(unmatchedId);
    try {
      const res = await fetch(`/api/admin/trackman/unmatched/${unmatchedId}/resolve`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ memberEmail })
      });
      if (res.ok) {
        showToast('Booking linked successfully', 'success');
        await new Promise(resolve => setTimeout(resolve, 300));
        fetchData();
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to link booking', 'error');
      }
    } catch (err) {
      console.error('Failed to link booking:', err);
      showToast('Failed to link booking', 'error');
    } finally {
      setIsLinkingMatch(null);
    }
  };

  const filteredMembers = members.filter(m => {
    const query = searchQuery.toLowerCase();
    const name = `${m.firstName || m.firstname || ''} ${m.lastName || m.lastname || ''}`.toLowerCase();
    const email = (m.email || '').toLowerCase();
    return name.includes(query) || email.includes(query);
  });

  const editFilteredMembers = members.filter(m => {
    const query = editSearchQuery.toLowerCase();
    const name = `${m.firstName || m.firstname || ''} ${m.lastName || m.lastname || ''}`.toLowerCase();
    const email = (m.email || '').toLowerCase();
    return name.includes(query) || email.includes(query);
  });

  const fuzzyFilteredMembers = members.filter(m => {
    if (!fuzzySearchQuery.trim()) return false;
    const query = fuzzySearchQuery.toLowerCase();
    const name = `${m.firstName || m.firstname || ''} ${m.lastName || m.lastname || ''}`.toLowerCase();
    const email = (m.email || '').toLowerCase();
    return name.includes(query) || email.includes(query);
  });

  const handlePullRefresh = async () => {
    await fetchData();
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <WalkingGolferSpinner size="lg" variant="dark" />
        <p className="text-sm text-primary/70 dark:text-white/70">Loading import data...</p>
      </div>
    );
  }

  return (
    <PullToRefresh onRefresh={handlePullRefresh}>
    <div className="px-6 pb-4 space-y-6">
      <div className="glass-card p-6 rounded-2xl border border-primary/10 dark:border-white/25">
        <h2 className="text-lg font-bold text-primary dark:text-white mb-4 flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined">upload_file</span>
          Import Trackman Bookings
        </h2>
        <p className="text-sm text-primary/70 dark:text-white/70 mb-4">
          Upload a Trackman booking export (CSV). The system will match bookings to existing members by name and email.
        </p>
        
        <input
          type="file"
          ref={fileInputRef}
          accept=".csv"
          onChange={handleFileSelect}
          className="hidden"
        />
        
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => !isImporting && fileInputRef.current?.click()}
          className={`
            border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all
            ${isDragging 
              ? 'border-accent bg-accent/10' 
              : 'border-primary/20 dark:border-white/20 hover:border-accent hover:bg-accent/5'}
            ${isImporting ? 'pointer-events-none opacity-50' : ''}
          `}
        >
          {isImporting ? (
            <div className="flex flex-col items-center gap-3">
              <WalkingGolferSpinner size="lg" variant="dark" />
              <p className="text-sm font-medium text-primary dark:text-white">Processing import...</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <span aria-hidden="true" className="material-symbols-outlined text-4xl text-primary/70 dark:text-white/70">cloud_upload</span>
              <p className="text-sm font-medium text-primary dark:text-white">
                Drop a CSV file here or click to browse
              </p>
              <p className="text-xs text-primary/70 dark:text-white/70">
                Export from Trackman and upload here
              </p>
            </div>
          )}
        </div>
        
        {importResult && (
          <div className={`mt-4 p-4 rounded-xl ${importResult.success ? 'bg-green-100 dark:bg-green-500/20' : 'bg-red-100 dark:bg-red-500/20'}`}>
            {importResult.success ? (
              <div className="space-y-1">
                <p className="font-bold text-green-700 dark:text-green-300">Import Complete</p>
                <p className="text-sm text-green-600 dark:text-green-400">
                  Total: {importResult.totalRows} | Matched: {importResult.matchedRows} | Linked: {importResult.linkedRows || 0} | Unmatched: {importResult.unmatchedRows} | Skipped: {importResult.skippedRows}
                  {(importResult.removedFromUnmatched > 0 || importResult.cancelledBookings > 0) && (
                    <span className="block mt-1">
                      Cleaned up: {importResult.removedFromUnmatched || 0} unmatched removed, {importResult.cancelledBookings || 0} bookings cancelled
                    </span>
                  )}
                </p>
              </div>
            ) : (
              <p className="text-red-700 dark:text-red-300">{importResult.error || 'Import failed'}</p>
            )}
          </div>
        )}
      </div>

      {importRuns.length > 0 && (
        <div className="glass-card p-6 rounded-2xl border border-primary/10 dark:border-white/25">
          <h2 className="text-lg font-bold text-primary dark:text-white mb-4 flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined">history</span>
            Import History
          </h2>
          <div className="space-y-2">
            {importRuns.slice(0, 5).map((run: any) => (
              <div key={run.id} className="p-3 bg-white/50 dark:bg-white/5 rounded-xl">
                <div className="flex flex-col gap-1">
                  <p className="font-medium text-primary dark:text-white text-sm truncate">{formatImportLabel(run.filename, run.createdAt)}</p>
                  <p className="text-xs text-primary/80 dark:text-white/80">
                    Imported {run.createdAt ? formatDateTimePacific(run.createdAt) : 'Unknown date'} by {run.importedBy || 'system'}
                  </p>
                  <div className="flex flex-wrap gap-2 mt-1">
                    <span className="text-xs text-green-600 dark:text-green-400">{run.matchedRows ?? 0} matched</span>
                    <span className="text-xs text-orange-600 dark:text-orange-400">{run.unmatchedRows ?? 0} unmatched</span>
                    <span className="text-xs text-primary/70 dark:text-white/70">{run.skippedRows ?? 0} skipped</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div ref={unmatchedSectionRef} className="glass-card p-6 rounded-2xl border border-primary/10 dark:border-white/25">
        <h2 className="text-lg font-bold text-primary dark:text-white mb-4 flex items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined">warning</span>
          Unmatched Bookings ({unmatchedTotalCount})
        </h2>
        <p className="text-sm text-primary/70 dark:text-white/70 mb-4">
          These bookings have no owner assigned. The email or name from Trackman didn't match any member in our system. Click "Resolve" to link each booking to the correct member so their visit history and usage are tracked properly.
        </p>
        
        <div className="mb-4">
          <div className="relative">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-primary/40 dark:text-white/40 text-lg">search</span>
            <input
              type="text"
              placeholder="Search by name or email..."
              value={unmatchedSearchQuery}
              onChange={(e) => setUnmatchedSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 rounded-xl bg-white/50 dark:bg-white/5 border border-primary/10 dark:border-white/10 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-accent text-sm"
            />
            {unmatchedSearchQuery && (
              <button
                onClick={() => setUnmatchedSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-primary/40 dark:text-white/40 hover:text-primary dark:hover:text-white"
              >
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            )}
          </div>
        </div>
        
        {unmatchedBookings.length === 0 && unmatchedTotalCount === 0 ? (
          <div className="py-8 text-center border-2 border-dashed border-primary/10 dark:border-white/25 rounded-xl">
            <span aria-hidden="true" className="material-symbols-outlined text-4xl text-primary/20 dark:text-white/20 mb-2">check_circle</span>
            <p className="text-primary/70 dark:text-white/70">No unmatched bookings</p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              {unmatchedBookings
                .filter((booking: any) => {
                  if (!unmatchedSearchQuery.trim()) return true;
                  const query = unmatchedSearchQuery.toLowerCase();
                  const name = (booking.userName || booking.user_name || '').toLowerCase();
                  const email = (booking.originalEmail || booking.original_email || '').toLowerCase();
                  return name.includes(query) || email.includes(query);
                })
                .map((booking: any) => (
                <div key={booking.id} className="p-4 bg-white/50 dark:bg-white/5 rounded-xl flex justify-between items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-primary dark:text-white truncate">
                      {booking.userName || booking.user_name || 'Unknown'}
                    </p>
                    <p className="text-xs text-primary/80 dark:text-white/80 truncate">
                      {booking.originalEmail || booking.original_email || 'No email'}
                    </p>
                    <p className="text-xs text-primary/80 dark:text-white/80 mt-1">
                      {formatDateDisplayWithDay(booking.bookingDate || booking.booking_date)} • {(booking.startTime || booking.start_time)?.substring(0, 5)} - {(booking.endTime || booking.end_time)?.substring(0, 5)} • Bay {booking.bayNumber || booking.bay_number}
                    </p>
                    <p className="text-xs text-orange-600 dark:text-orange-400 mt-1">
                      {booking.matchAttemptReason || booking.match_attempt_reason}
                    </p>
                  </div>
                  <button
                    onClick={() => { setSearchQuery(''); setResolveModal({ booking, memberEmail: '' }); }}
                    className="px-3 py-1.5 bg-accent text-primary rounded-lg text-xs font-bold hover:opacity-90 transition-opacity shrink-0"
                  >
                    Resolve
                  </button>
                </div>
              ))}
            </div>
            {unmatchedTotalPages > 1 && (
              <div className="flex items-center justify-between pt-3 border-t border-primary/10 dark:border-white/10">
                <p className="text-xs text-primary/60 dark:text-white/60">
                  Page {unmatchedPage} of {unmatchedTotalPages} ({unmatchedTotalCount} total)
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => { setUnmatchedPage(p => Math.max(1, p - 1)); fetchUnmatched(unmatchedPage - 1, unmatchedSearchQuery); unmatchedSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
                    disabled={unmatchedPage <= 1}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary/10 dark:bg-white/10 text-primary dark:text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/20 dark:hover:bg-white/20 transition-colors"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => { setUnmatchedPage(p => Math.min(unmatchedTotalPages, p + 1)); fetchUnmatched(unmatchedPage + 1, unmatchedSearchQuery); unmatchedSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
                    disabled={unmatchedPage >= unmatchedTotalPages}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary/10 dark:bg-white/10 text-primary dark:text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/20 dark:hover:bg-white/20 transition-colors"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {requiresReviewBookings.length > 0 && (
        <div className="glass-card p-6 rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-amber-50/50 dark:bg-amber-900/10">
          <h2 className="text-lg font-bold text-primary dark:text-white mb-4 flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined text-amber-600 dark:text-amber-400">person_search</span>
            Requires Review ({requiresReviewTotalCount})
          </h2>
          <p className="text-sm text-primary/70 dark:text-white/70 mb-4">
            These bookings have incomplete info (like "Bobby S." or just a first name) so the system couldn't auto-match them. Click "Find Matches" to search for the member and assign them as the owner. This ensures their visit counts toward their account.
          </p>
          
          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {requiresReviewBookings.map((booking: any) => (
              <div key={booking.id} className="p-4 bg-white/80 dark:bg-white/5 rounded-xl flex justify-between items-start gap-3 border border-amber-200/50 dark:border-amber-500/20">
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-primary dark:text-white truncate">
                    {booking.userName || booking.user_name || 'Unknown'}
                  </p>
                  <p className="text-xs text-primary/80 dark:text-white/80 mt-1">
                    {formatDateDisplayWithDay(booking.bookingDate || booking.booking_date)} • {(booking.startTime || booking.start_time)?.substring(0, 5)} - {(booking.endTime || booking.end_time)?.substring(0, 5)} • Bay {booking.bayNumber || booking.bay_number}
                  </p>
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1">
                    <span className="material-symbols-outlined text-xs">info</span>
                    Partial name - needs member matching
                  </p>
                </div>
                <button
                  onClick={() => handleOpenFuzzyMatchModal(booking)}
                  className="px-3 py-1.5 bg-amber-500 text-white rounded-lg text-xs font-bold hover:bg-amber-600 transition-colors shrink-0 flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-sm">search</span>
                  Find Matches
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {potentialMatches.length > 0 && (
        <div className="glass-card p-6 rounded-2xl border border-primary/10 dark:border-white/25">
          <h2 className="text-lg font-bold text-primary dark:text-white mb-4 flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined">compare_arrows</span>
            Potential Matches ({potentialMatchesTotalCount})
          </h2>
          <p className="text-sm text-primary/70 dark:text-white/70 mb-4">
            These Trackman bookings weren't auto-matched, but the system found app bookings from the same time that might be the same session. Click "Link" to connect them - this matches the Trackman data to the member's existing booking in our system.
          </p>
          
          <div className="space-y-4 max-h-[500px] overflow-y-auto">
            {potentialMatches.map((item: any) => (
              <div key={item.id} className="p-4 bg-white/50 dark:bg-white/5 rounded-xl border border-primary/10 dark:border-white/10">
                <div className="flex justify-between items-start gap-3 mb-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-primary dark:text-white truncate">
                      {item.user_name || 'Unknown'}
                    </p>
                    <p className="text-xs text-primary/80 dark:text-white/80 truncate">
                      {item.original_email || 'No email'}
                    </p>
                    <p className="text-xs text-primary/80 dark:text-white/80 mt-1">
                      {formatDateDisplayWithDay(item.booking_date)} • {item.start_time?.substring(0, 5)} - {item.end_time?.substring(0, 5)} • Bay {item.bay_number}
                    </p>
                  </div>
                </div>
                
                {item.potentialAppBookings && item.potentialAppBookings.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-primary/10 dark:border-white/10">
                    <p className="text-xs font-medium text-primary/60 dark:text-white/60 mb-2 uppercase tracking-wide">
                      Potential Matches:
                    </p>
                    <div className="space-y-2">
                      {item.potentialAppBookings.map((match: any) => (
                        <div key={match.id} className="flex items-center justify-between gap-2 p-2 bg-green-50 dark:bg-green-500/10 rounded-lg">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-primary dark:text-white truncate">
                              {match.userName}
                            </p>
                            <p className="text-xs text-primary/70 dark:text-white/70 truncate">
                              {match.userEmail}
                            </p>
                          </div>
                          <button
                            onClick={() => handleLinkPotentialMatch(item.id, match.id, match.userEmail)}
                            disabled={isLinkingMatch === item.id}
                            className="px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-bold hover:bg-green-700 transition-colors disabled:opacity-50 shrink-0 flex items-center gap-1"
                          >
                            {isLinkingMatch === item.id ? (
                              <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                            ) : (
                              <span className="material-symbols-outlined text-sm">link</span>
                            )}
                            Link
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {needsPlayersBookings.length > 0 && (
        <div ref={needsPlayersSectionRef} className="glass-card p-6 rounded-2xl border border-primary/10 dark:border-white/25">
          <h2 className="text-lg font-bold text-primary dark:text-white mb-4 flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined">group_add</span>
            Needs Players ({needsPlayersTotalCount})
          </h2>
          <p className="text-sm text-primary/70 dark:text-white/70 mb-4">
            These bookings have an owner, but Trackman recorded more players than are currently assigned. For example, "1/3 Assigned" means 1 of 3 players is identified. Click "Manage" to add the other players so each person's usage is tracked correctly for billing and fair usage limits.
          </p>
          
          <div className="mb-4">
            <div className="relative">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-primary/40 dark:text-white/40 text-lg">search</span>
              <input
                type="text"
                placeholder="Search by name or email..."
                value={needsPlayersSearchQuery}
                onChange={(e) => setNeedsPlayersSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 rounded-xl bg-white/50 dark:bg-white/5 border border-primary/10 dark:border-white/10 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-accent text-sm"
              />
              {needsPlayersSearchQuery && (
                <button
                  onClick={() => setNeedsPlayersSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-primary/40 dark:text-white/40 hover:text-primary dark:hover:text-white"
                >
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              )}
            </div>
          </div>
          
          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {needsPlayersBookings.map((booking: any) => {
              const expectedCount = booking.slotInfo?.totalSlots || booking.slotInfo?.expectedPlayerCount || booking.trackmanPlayerCount || booking.playerCount || booking.player_count || 1;
              const assignedCount = booking.slotInfo?.filledSlots || booking.assignedCount || booking.assigned_count || 0;
              const isComplete = assignedCount >= expectedCount;
              
              return (
                <div key={booking.id} className="p-4 bg-white/50 dark:bg-white/5 rounded-xl flex justify-between items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="font-bold text-primary dark:text-white truncate">
                        {booking.userName || booking.user_name || 'Unknown'}
                      </p>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                        isComplete 
                          ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300' 
                          : 'bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300'
                      }`}>
                        {assignedCount}/{expectedCount} Assigned
                      </span>
                    </div>
                    <p className="text-xs text-primary/80 dark:text-white/80 truncate">
                      {booking.userEmail || booking.user_email || 'No email'}
                    </p>
                    <p className="text-xs text-primary/80 dark:text-white/80 mt-1">
                      {formatDateDisplayWithDay(booking.requestDate || booking.request_date)} • Bay {booking.resourceId || booking.resource_id}
                    </p>
                  </div>
                  <button
                    onClick={() => setManagePlayersModal({ 
                      booking: {
                        id: booking.id,
                        userEmail: booking.userEmail || booking.user_email,
                        userName: booking.userName || booking.user_name || 'Unknown',
                        resourceId: booking.resourceId || booking.resource_id,
                        requestDate: booking.requestDate || booking.request_date,
                        startTime: booking.startTime || booking.start_time || '',
                        notes: booking.notes || '',
                        playerCount: expectedCount
                      }
                    })}
                    className="px-3 py-1.5 bg-accent text-primary rounded-lg text-xs font-bold hover:opacity-90 transition-opacity shrink-0 flex items-center gap-1"
                  >
                    <span className="material-symbols-outlined text-sm">group</span>
                    Manage
                  </button>
                </div>
              );
            })}
          </div>
          
          {needsPlayersTotalPages > 1 && (
            <div className="flex items-center justify-between pt-3 mt-3 border-t border-primary/10 dark:border-white/10">
              <p className="text-xs text-primary/60 dark:text-white/60">
                Page {needsPlayersPage} of {needsPlayersTotalPages} ({needsPlayersTotalCount} total)
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => { setNeedsPlayersPage(p => Math.max(1, p - 1)); fetchNeedsPlayers(needsPlayersPage - 1, needsPlayersSearchQuery); needsPlayersSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
                  disabled={needsPlayersPage <= 1}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary/10 dark:bg-white/10 text-primary dark:text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/20 dark:hover:bg-white/20 transition-colors"
                >
                  Previous
                </button>
                <button
                  onClick={() => { setNeedsPlayersPage(p => Math.min(needsPlayersTotalPages, p + 1)); fetchNeedsPlayers(needsPlayersPage + 1, needsPlayersSearchQuery); needsPlayersSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
                  disabled={needsPlayersPage >= needsPlayersTotalPages}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary/10 dark:bg-white/10 text-primary dark:text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/20 dark:hover:bg-white/20 transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div ref={matchedSectionRef} className="glass-card p-6 rounded-2xl border border-primary/10 dark:border-white/25">
        <button
          onClick={() => setShowMatchedBookings(!showMatchedBookings)}
          className="w-full flex items-center justify-between"
        >
          <h2 className="text-lg font-bold text-primary dark:text-white flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined">check_circle</span>
            Matched Bookings ({matchedTotalCount})
          </h2>
          <span aria-hidden="true" className={`material-symbols-outlined text-primary/60 dark:text-white/60 transition-transform ${showMatchedBookings ? 'rotate-180' : ''}`}>
            expand_more
          </span>
        </button>
        
        {showMatchedBookings && (
          <div className="mt-4">
            <p className="text-sm text-primary/70 dark:text-white/70 mb-4">
              These bookings are complete - the owner is assigned and all player slots are filled. The "1/1 assigned" badge means all players are accounted for. Click "Edit" if a match was wrong and needs to be reassigned to a different member.
            </p>
            
            <div className="mb-4">
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-primary/40 dark:text-white/40 text-lg">search</span>
                <input
                  type="text"
                  placeholder="Search by name or email..."
                  value={matchedSearchQuery}
                  onChange={(e) => setMatchedSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 rounded-xl bg-white/50 dark:bg-white/5 border border-primary/10 dark:border-white/10 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-accent text-sm"
                />
                {matchedSearchQuery && (
                  <button
                    onClick={() => setMatchedSearchQuery('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-primary/40 dark:text-white/40 hover:text-primary dark:hover:text-white"
                  >
                    <span className="material-symbols-outlined text-lg">close</span>
                  </button>
                )}
              </div>
            </div>
            
            {matchedBookings.length === 0 ? (
              <div className="py-8 text-center border-2 border-dashed border-primary/10 dark:border-white/25 rounded-xl">
                <span aria-hidden="true" className="material-symbols-outlined text-4xl text-primary/20 dark:text-white/20 mb-2">inbox</span>
                <p className="text-primary/70 dark:text-white/70">No matched bookings yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="space-y-2 max-h-[400px] overflow-y-auto">
                  {matchedBookings
                    .filter((booking: any) => {
                      if (!matchedSearchQuery.trim()) return true;
                      const query = matchedSearchQuery.toLowerCase();
                      const name = (booking.userName || booking.user_name || '').toLowerCase();
                      const email = (booking.userEmail || booking.user_email || '').toLowerCase();
                      const memberName = (booking.member?.fullName || '').toLowerCase();
                      return name.includes(query) || email.includes(query) || memberName.includes(query);
                    })
                    .map((booking: any) => (
                    <div key={booking.id} className="p-4 bg-white/50 dark:bg-white/5 rounded-xl flex justify-between items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-primary dark:text-white truncate">
                          {booking.userName || booking.user_name || 'Unknown'}
                        </p>
                        <p className="text-xs text-green-600 dark:text-green-400 truncate">
                          Assigned to: {booking.member?.fullName || booking.userEmail || booking.user_email}
                        </p>
                        <p className="text-xs text-primary/80 dark:text-white/80 mt-1">
                          {formatDateDisplayWithDay(booking.requestDate || booking.request_date)} • {(booking.startTime || booking.start_time)?.substring(0, 5)} - {(booking.endTime || booking.end_time)?.substring(0, 5)} • Bay {booking.resourceId || booking.resource_id}
                        </p>
                        {booking.slotInfo && (
                          <p className="text-xs text-accent dark:text-accent mt-1 flex items-center gap-1">
                            <span className="material-symbols-outlined text-xs">group</span>
                            {booking.slotInfo.filledSlots}/{booking.slotInfo.totalSlots} assigned
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          onClick={() => setViewDetailBooking(booking)}
                          className="px-3 py-1.5 bg-accent/20 text-accent rounded-lg text-xs font-bold hover:bg-accent/30 transition-colors flex items-center gap-1"
                        >
                          <span className="material-symbols-outlined text-sm">visibility</span>
                          View
                        </button>
                        <button
                          onClick={() => { setEditSearchQuery(''); setEditMatchedModal({ booking, newMemberEmail: '' }); }}
                          className="px-3 py-1.5 bg-primary/10 dark:bg-white/10 text-primary dark:text-white rounded-lg text-xs font-bold hover:bg-primary/20 dark:hover:bg-white/20 transition-colors"
                        >
                          Edit
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                {matchedTotalPages > 1 && (
                  <div className="flex items-center justify-between pt-3 border-t border-primary/10 dark:border-white/10">
                    <p className="text-xs text-primary/60 dark:text-white/60">
                      Page {matchedPage} of {matchedTotalPages} ({matchedTotalCount} total)
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setMatchedPage(p => Math.max(1, p - 1)); fetchMatched(matchedPage - 1, matchedSearchQuery); matchedSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
                        disabled={matchedPage <= 1}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary/10 dark:bg-white/10 text-primary dark:text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/20 dark:hover:bg-white/20 transition-colors"
                      >
                        Previous
                      </button>
                      <button
                        onClick={() => { setMatchedPage(p => Math.min(matchedTotalPages, p + 1)); fetchMatched(matchedPage + 1, matchedSearchQuery); matchedSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
                        disabled={matchedPage >= matchedTotalPages}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary/10 dark:bg-white/10 text-primary dark:text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/20 dark:hover:bg-white/20 transition-colors"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <ModalShell isOpen={!!resolveModal} onClose={() => setResolveModal(null)} title="Resolve Booking" showCloseButton={false}>
        <div className="space-y-4">
          <div className="p-4 border-b border-primary/10 dark:border-white/25 bg-primary/5 dark:bg-white/5">
            <div className="p-3 rounded-xl bg-white/80 dark:bg-white/10">
              <p className="font-semibold text-primary dark:text-white">
                {resolveModal?.booking?.userName || resolveModal?.booking?.user_name || 'Unknown'}
              </p>
              <p className="text-xs text-primary/70 dark:text-white/70 mt-0.5">
                {resolveModal?.booking?.originalEmail || resolveModal?.booking?.original_email || 'No email'}
              </p>
              <p className="text-xs text-primary/80 dark:text-white/80 mt-1">
                {formatDateDisplayWithDay(resolveModal?.booking?.bookingDate || resolveModal?.booking?.booking_date)} • Bay {resolveModal?.booking?.bayNumber || resolveModal?.booking?.bay_number}
              </p>
            </div>
          </div>
          <div className="p-6 pt-0 space-y-4">
            <div>
              <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                Select member to assign this booking:
              </label>
              <input
                type="text"
                placeholder="Search by name or email..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/70 dark:placeholder:text-white/60 text-base"
              />
            </div>
            <div className="max-h-64 overflow-y-auto space-y-2 -mx-2 px-2">
              {filteredMembers.slice(0, 20).map((member: any) => (
                <button
                  key={member.email}
                  onClick={() => resolveModal && setResolveModal({ ...resolveModal, memberEmail: member.email })}
                  className={`w-full p-4 text-left rounded-xl transition-all ${
                    resolveModal?.memberEmail === member.email
                      ? 'bg-accent/30 border-2 border-accent shadow-md'
                      : 'bg-white/70 dark:bg-white/5 border border-primary/10 dark:border-white/25 hover:bg-white dark:hover:bg-white/10 hover:border-primary/20 dark:hover:border-white/20'
                  }`}
                >
                  <p className="font-semibold text-primary dark:text-white text-base">
                    {member.firstName || member.firstname || ''} {member.lastName || member.lastname || ''}
                  </p>
                  <p className="text-sm text-primary/80 dark:text-white/80 mt-0.5">{member.email}</p>
                </button>
              ))}
              {filteredMembers.length === 0 && searchQuery && (
                <p className="text-center py-4 text-primary/70 dark:text-white/70">No members found</p>
              )}
            </div>
            <div className="flex justify-end gap-3 pt-4 border-t border-primary/10 dark:border-white/25">
              <button
                onClick={() => setResolveModal(null)}
                className="px-5 py-2.5 rounded-full text-sm font-medium text-primary/70 dark:text-white/70 hover:bg-primary/10 dark:hover:bg-white/10 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleResolve}
                disabled={!resolveModal?.memberEmail}
                className="px-6 py-2.5 rounded-full bg-accent text-primary text-sm font-bold hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
              >
                Assign & Resolve
              </button>
            </div>
          </div>
        </div>
      </ModalShell>

      <ModalShell isOpen={!!editMatchedModal} onClose={() => { setEditMatchedModal(null); setEditSearchQuery(''); }} title="Reassign Booking" showCloseButton={false}>
        <div className="space-y-4">
          <div className="p-4 border-b border-primary/10 dark:border-white/25 bg-primary/5 dark:bg-white/5">
            <div className="p-3 rounded-xl bg-white/80 dark:bg-white/10">
              <p className="font-semibold text-primary dark:text-white">
                {editMatchedModal?.booking?.userName || editMatchedModal?.booking?.user_name || 'Unknown'}
              </p>
              <p className="text-xs text-green-600 dark:text-green-400 mt-0.5">
                Currently assigned to: {editMatchedModal?.booking?.member?.fullName || editMatchedModal?.booking?.userEmail || editMatchedModal?.booking?.user_email}
              </p>
              <p className="text-xs text-primary/80 dark:text-white/80 mt-1">
                {formatDateDisplayWithDay(editMatchedModal?.booking?.requestDate || editMatchedModal?.booking?.request_date)} • Bay {editMatchedModal?.booking?.resourceId || editMatchedModal?.booking?.resource_id}
              </p>
            </div>
          </div>
          <div className="p-6 pt-0 space-y-4">
            <div>
              <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                Select new member to reassign this booking:
              </label>
              <input
                type="text"
                placeholder="Search by name or email..."
                value={editSearchQuery}
                onChange={(e) => setEditSearchQuery(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-white dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/70 dark:placeholder:text-white/60 text-base"
              />
            </div>
            <div className="max-h-64 overflow-y-auto space-y-2 -mx-2 px-2">
              {editFilteredMembers.slice(0, 20).map((member: any) => (
                <button
                  key={member.email}
                  onClick={() => editMatchedModal && setEditMatchedModal({ ...editMatchedModal, newMemberEmail: member.email })}
                  className={`w-full p-4 text-left rounded-xl transition-all ${
                    editMatchedModal?.newMemberEmail === member.email
                      ? 'bg-accent/30 border-2 border-accent shadow-md'
                      : 'bg-white/70 dark:bg-white/5 border border-primary/10 dark:border-white/25 hover:bg-white dark:hover:bg-white/10 hover:border-primary/20 dark:hover:border-white/20'
                  }`}
                >
                  <p className="font-semibold text-primary dark:text-white text-base">
                    {member.firstName || member.firstname || ''} {member.lastName || member.lastname || ''}
                  </p>
                  <p className="text-sm text-primary/80 dark:text-white/80 mt-0.5">{member.email}</p>
                </button>
              ))}
              {editFilteredMembers.length === 0 && editSearchQuery && (
                <p className="text-center py-4 text-primary/70 dark:text-white/70">No members found</p>
              )}
            </div>
            <div className="flex justify-end gap-3 pt-4 border-t border-primary/10 dark:border-white/25">
              <button
                onClick={() => { setEditMatchedModal(null); setEditSearchQuery(''); }}
                className="px-5 py-2.5 rounded-full text-sm font-medium text-primary/70 dark:text-white/70 hover:bg-primary/10 dark:hover:bg-white/10 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleReassignMatched}
                disabled={!editMatchedModal?.newMemberEmail}
                className="px-6 py-2.5 rounded-full bg-accent text-primary text-sm font-bold hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
              >
                Reassign Booking
              </button>
            </div>
          </div>
        </div>
      </ModalShell>

      {managePlayersModal && (
        <ManagePlayersModal
          isOpen={!!managePlayersModal}
          onClose={() => setManagePlayersModal(null)}
          booking={managePlayersModal.booking}
          onSaved={() => {
            fetchData();
          }}
        />
      )}

      <ModalShell isOpen={!!viewDetailBooking} onClose={() => setViewDetailBooking(null)} title="Booking Details">
        {viewDetailBooking && (
          <div className="p-6 space-y-4">
            <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white text-lg">person</span>
                <div>
                  <p className="font-bold text-primary dark:text-white">
                    {viewDetailBooking.member?.fullName || viewDetailBooking.userName || viewDetailBooking.user_name || 'Unknown'}
                  </p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">{viewDetailBooking.userEmail || viewDetailBooking.user_email}</p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Date</p>
                <p className="font-medium text-primary dark:text-white text-sm">{formatDateDisplayWithDay(viewDetailBooking.requestDate || viewDetailBooking.request_date)}</p>
              </div>
              <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Time</p>
                <p className="font-medium text-primary dark:text-white text-sm">
                  {formatTime12Hour(viewDetailBooking.startTime || viewDetailBooking.start_time)} - {formatTime12Hour(viewDetailBooking.endTime || viewDetailBooking.end_time)}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Duration</p>
                <p className="font-medium text-primary dark:text-white text-sm">{viewDetailBooking.durationMinutes || viewDetailBooking.duration_minutes} min</p>
              </div>
              <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Bay/Resource</p>
                <p className="font-medium text-primary dark:text-white text-sm">Bay {viewDetailBooking.resourceId || viewDetailBooking.resource_id}</p>
              </div>
            </div>

            {(viewDetailBooking.slotInfo || viewDetailBooking.trackmanPlayerCount) && (
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-accent/10 dark:bg-accent/20 rounded-lg border border-accent/30">
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Players</p>
                  <p className="font-medium text-primary dark:text-white text-sm flex items-center gap-1">
                    <span className="material-symbols-outlined text-accent text-base">group</span>
                    {viewDetailBooking.slotInfo?.totalSlots || viewDetailBooking.trackmanPlayerCount || 1} {(viewDetailBooking.slotInfo?.totalSlots || viewDetailBooking.trackmanPlayerCount || 1) === 1 ? 'player' : 'players'}
                  </p>
                </div>
                <div className="p-3 bg-green-50 dark:bg-green-500/10 rounded-lg border border-green-200 dark:border-green-500/30">
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Assigned</p>
                  <p className="font-medium text-primary dark:text-white text-sm flex items-center gap-1">
                    <span className="material-symbols-outlined text-green-600 text-base">check_circle</span>
                    {viewDetailBooking.slotInfo?.filledSlots || 0}/{viewDetailBooking.slotInfo?.totalSlots || 1} slots filled
                  </p>
                </div>
              </div>
            )}

            {viewDetailBooking.trackmanBookingId && (
              <div className="p-3 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 rounded-lg">
                <p className="text-xs text-blue-600 dark:text-blue-400 mb-1 flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">link</span>
                  Trackman ID
                </p>
                <p className="font-medium text-primary dark:text-white text-sm">{viewDetailBooking.trackmanBookingId}</p>
              </div>
            )}

            {viewDetailBooking.notes && (
              <div className="p-3 bg-gray-50 dark:bg-white/5 rounded-lg">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Notes</p>
                <p className="font-medium text-primary dark:text-white text-sm whitespace-pre-wrap">{viewDetailBooking.notes}</p>
              </div>
            )}

            <div className="border-t border-primary/10 dark:border-white/10 pt-4">
              <RosterManager
                bookingId={typeof viewDetailBooking.id === 'string' ? parseInt(viewDetailBooking.id, 10) : viewDetailBooking.id}
                declaredPlayerCount={viewDetailBooking.slotInfo?.totalSlots || viewDetailBooking.trackmanPlayerCount || 1}
                isOwner={false}
                isStaff={true}
                onUpdate={() => {
                  fetchData();
                }}
              />
            </div>

            <div className="flex justify-end pt-3">
              <button
                onClick={() => setViewDetailBooking(null)}
                className="px-5 py-2.5 rounded-full bg-primary/10 dark:bg-white/10 text-primary dark:text-white text-sm font-medium hover:bg-primary/20 dark:hover:bg-white/20 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </ModalShell>

      <ModalShell isOpen={!!fuzzyMatchModal} onClose={() => { setFuzzyMatchModal(null); setFuzzySearchQuery(''); }} title="Find Member Match">
        <div className="p-6">
          <div className="p-4 bg-amber-50 dark:bg-amber-900/20 rounded-xl border border-amber-200 dark:border-amber-500/30 mb-4">
            <div className="flex items-center gap-2 mb-2">
              <span aria-hidden="true" className="material-symbols-outlined text-amber-600 dark:text-amber-400">person_search</span>
              <p className="font-bold text-primary dark:text-white">
                {fuzzyMatchModal?.booking?.userName || fuzzyMatchModal?.booking?.user_name || 'Unknown'}
              </p>
            </div>
            <p className="text-xs text-primary/80 dark:text-white/80">
              {formatDateDisplayWithDay(fuzzyMatchModal?.booking?.bookingDate || fuzzyMatchModal?.booking?.booking_date)} • Bay {fuzzyMatchModal?.booking?.bayNumber || fuzzyMatchModal?.booking?.bay_number}
            </p>
          </div>
          
          {fuzzyMatchModal?.isLoading ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <WalkingGolferSpinner size="md" variant="dark" />
              <p className="text-sm text-primary/70 dark:text-white/70">Finding matches...</p>
            </div>
          ) : (
            <>
              {fuzzyMatchModal?.matches && fuzzyMatchModal.matches.length > 0 && (
                <div className="mb-4">
                  <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                    Suggested Matches:
                  </label>
                  <div className="max-h-40 overflow-y-auto space-y-2 -mx-2 px-2">
                    {fuzzyMatchModal.matches.map((match: any, idx: number) => (
                      <button
                        key={match.email || idx}
                        onClick={() => setFuzzyMatchModal(prev => prev ? { ...prev, selectedEmail: match.email } : null)}
                        className={`w-full p-3 text-left rounded-xl transition-all ${
                          fuzzyMatchModal?.selectedEmail === match.email
                            ? 'bg-amber-100 dark:bg-amber-500/20 border-2 border-amber-500 shadow-md'
                            : 'bg-white/70 dark:bg-white/5 border border-primary/10 dark:border-white/25 hover:bg-white dark:hover:bg-white/10 hover:border-primary/20 dark:hover:border-white/20'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-semibold text-primary dark:text-white text-sm">
                              {match.firstName || ''} {match.lastName || ''}
                            </p>
                            <p className="text-xs text-primary/80 dark:text-white/80">{match.email}</p>
                          </div>
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                            match.score >= 80 
                              ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300'
                              : match.score >= 60
                                ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300'
                                : 'bg-gray-100 text-gray-700 dark:bg-gray-500/20 dark:text-gray-300'
                          }`}>
                            {match.score}%
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              
              <div className="mb-4">
                <label className="block text-sm font-medium text-primary dark:text-white mb-2">
                  {fuzzyMatchModal?.matches && fuzzyMatchModal.matches.length > 0 ? 'Or search for a member:' : 'Search for a member:'}
                </label>
                <div className="relative">
                  <span aria-hidden="true" className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-primary/40 dark:text-white/40 text-lg">search</span>
                  <input
                    type="text"
                    value={fuzzySearchQuery}
                    onChange={e => setFuzzySearchQuery(e.target.value)}
                    placeholder="Type member name or email..."
                    className="w-full pl-10 pr-4 py-3 rounded-xl bg-white/70 dark:bg-white/5 border border-primary/10 dark:border-white/25 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                  />
                </div>
              </div>
              
              {fuzzySearchQuery.trim() && (
                <div className="max-h-48 overflow-y-auto space-y-2 -mx-2 px-2 mb-4">
                  {fuzzyFilteredMembers.slice(0, 15).map((member: any) => (
                    <button
                      key={member.email}
                      onClick={() => setFuzzyMatchModal(prev => prev ? { ...prev, selectedEmail: member.email } : null)}
                      className={`w-full p-3 text-left rounded-xl transition-all ${
                        fuzzyMatchModal?.selectedEmail === member.email
                          ? 'bg-amber-100 dark:bg-amber-500/20 border-2 border-amber-500 shadow-md'
                          : 'bg-white/70 dark:bg-white/5 border border-primary/10 dark:border-white/25 hover:bg-white dark:hover:bg-white/10 hover:border-primary/20 dark:hover:border-white/20'
                      }`}
                    >
                      <p className="font-semibold text-primary dark:text-white text-sm">
                        {member.firstName || member.firstname || ''} {member.lastName || member.lastname || ''}
                      </p>
                      <p className="text-xs text-primary/80 dark:text-white/80">{member.email}</p>
                    </button>
                  ))}
                  {fuzzyFilteredMembers.length === 0 && (
                    <p className="text-center py-4 text-primary/70 dark:text-white/70 text-sm">No members found for "{fuzzySearchQuery}"</p>
                  )}
                </div>
              )}
              
              {!fuzzyMatchModal?.matches?.length && !fuzzySearchQuery.trim() && (
                <div className="py-6 text-center border-2 border-dashed border-primary/10 dark:border-white/25 rounded-xl mb-4">
                  <span aria-hidden="true" className="material-symbols-outlined text-3xl text-primary/20 dark:text-white/20 mb-2">person_add</span>
                  <p className="text-primary/70 dark:text-white/70 text-sm">No auto-suggestions available</p>
                  <p className="text-xs text-primary/50 dark:text-white/50 mt-1">Use the search above to find a member</p>
                </div>
              )}
            </>
          )}
          
          <div className="flex justify-end gap-3 pt-4 border-t border-primary/10 dark:border-white/25">
            <button
              onClick={() => { setFuzzyMatchModal(null); setFuzzySearchQuery(''); }}
              className="px-5 py-2.5 rounded-full text-sm font-medium text-primary/70 dark:text-white/70 hover:bg-primary/10 dark:hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleResolveFuzzyMatch}
              disabled={!fuzzyMatchModal?.selectedEmail}
              className="px-6 py-2.5 rounded-full bg-amber-500 text-white text-sm font-bold hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              Resolve with Selected Member
            </button>
          </div>
        </div>
      </ModalShell>
    </div>
    </PullToRefresh>
  );
};

export default TrackmanTab;

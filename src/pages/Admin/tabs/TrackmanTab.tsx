import React, { useState, useEffect, useRef } from 'react';
import { usePageReady } from '../../../contexts/PageReadyContext';
import { useData } from '../../../contexts/DataContext';
import { useToast } from '../../../components/Toast';
import { formatDateTimePacific, formatDateDisplayWithDay } from '../../../utils/dateUtils';
import WalkingGolferSpinner from '../../../components/WalkingGolferSpinner';
import ModalShell from '../../../components/ModalShell';
import PullToRefresh from '../../../components/PullToRefresh';
import BookingMembersEditor from '../../../components/admin/BookingMembersEditor';
import RosterManager from '../../../components/booking/RosterManager';
import { TrackmanLinkModal } from '../../../components/staff-command-center/modals/TrackmanLinkModal';

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
  
  let cleaned = filename.replace(/\.(csv|xlsx?)$/i, '').replace(/^(trackman[_\s-]*|import[_\s-]*)/i, '');
  
  if (!cleaned || cleaned.length > 40 || /^[a-f0-9-]{20,}$/i.test(cleaned)) {
    return 'Trackman Import';
  }
  
  return cleaned.replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim() || 'Trackman Import';
};

const TrackmanTab: React.FC = () => {
  const pageReadyContext = usePageReady();
  const dataContext = useData();
  const toastContext = useToast();
  
  const setPageReady = pageReadyContext?.setPageReady || (() => {});
  const actualUser = dataContext?.actualUser;
  const showToast = toastContext?.showToast || (() => {});
  const [unmatchedBookings, setUnmatchedBookings] = useState<any[]>([]);
  const [unmatchedTotalCount, setUnmatchedTotalCount] = useState<number>(0);
  const [unmatchedPage, setUnmatchedPage] = useState(1);
  const [needsPlayersBookings, setNeedsPlayersBookings] = useState<any[]>([]);
  const [needsPlayersTotalCount, setNeedsPlayersTotalCount] = useState<number>(0);
  const [needsPlayersPage, setNeedsPlayersPage] = useState(1);
  const [needsPlayersSearchQuery, setNeedsPlayersSearchQuery] = useState('');
  const [fuzzyMatchModal, setFuzzyMatchModal] = useState<{ booking: any; matches: any[]; isLoading: boolean; selectedEmail: string; rememberEmail: boolean } | null>(null);
  const [importRuns, setImportRuns] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  const [assignPlayersModal, setAssignPlayersModal] = useState<{ booking: any; isOpen: boolean } | null>(null);
  const [managePlayersModal, setManagePlayersModal] = useState<{ 
    bookingId: number;
    bookingContext: {
      requestDate?: string;
      startTime?: string;
      endTime?: string;
      resourceId?: number;
      resourceName?: string;
      durationMinutes?: number;
      notes?: string;
      ownerName?: string;
    };
  } | null>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [unmatchedSearchQuery, setUnmatchedSearchQuery] = useState('');
  const [fuzzySearchQuery, setFuzzySearchQuery] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [viewDetailBooking, setViewDetailBooking] = useState<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const unmatchedSectionRef = useRef<HTMLDivElement>(null);
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

  const handleOpenFuzzyMatchModal = async (booking: any) => {
    setFuzzyMatchModal({ booking, matches: [], isLoading: true, selectedEmail: '', rememberEmail: true });
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
        const originalEmail = fuzzyMatchModal.booking?.originalEmail || fuzzyMatchModal.booking?.original_email;
        const shouldRemember = fuzzyMatchModal.rememberEmail && originalEmail && 
          originalEmail.toLowerCase() !== fuzzyMatchModal.selectedEmail.toLowerCase();
        
        if (shouldRemember) {
          try {
            await fetch('/api/admin/linked-emails', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                primaryEmail: fuzzyMatchModal.selectedEmail,
                linkedEmail: originalEmail
              })
            });
          } catch (linkErr) {
            console.warn('Failed to save email link:', linkErr);
          }
        }
        
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
      const needsPlayersOffset = (needsPlayersPage - 1) * ITEMS_PER_PAGE;
      const [unmatchedRes, runsRes, membersRes, needsPlayersRes] = await Promise.all([
        fetch(`/api/admin/trackman/unmatched?resolved=false&limit=${ITEMS_PER_PAGE}&offset=${unmatchedOffset}&${cacheBuster}`, { credentials: 'include' }),
        fetch(`/api/admin/trackman/import-runs?${cacheBuster}`, { credentials: 'include' }),
        fetch('/api/hubspot/contacts?status=all', { credentials: 'include' }),
        fetch(`/api/admin/trackman/needs-players?limit=${ITEMS_PER_PAGE}&offset=${needsPlayersOffset}&${cacheBuster}`, { credentials: 'include' })
      ]);
      
      if (unmatchedRes.ok) {
        const result = await unmatchedRes.json();
        setUnmatchedBookings(result.data || []);
        setUnmatchedTotalCount(result.totalCount || 0);
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
    } catch (err) {
      console.error('Failed to fetch Trackman data:', err);
    } finally {
      setIsLoading(false);
      setPageReady(true);
    }
  };

  const unmatchedTotalPages = Math.ceil(unmatchedTotalCount / ITEMS_PER_PAGE);
  const needsPlayersTotalPages = Math.ceil(needsPlayersTotalCount / ITEMS_PER_PAGE);

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      setUnmatchedPage(1);
      fetchUnmatched(1, unmatchedSearchQuery);
    }, 300);
    return () => clearTimeout(debounceTimer);
  }, [unmatchedSearchQuery]);

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
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);
    
    try {
      const formData = new FormData();
      formData.append('file', file);
      
      const res = await fetch('/api/admin/trackman/upload', {
        method: 'POST',
        credentials: 'include',
        body: formData,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const data = await res.json();
      setImportResult(data);
      fetchData();
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        setImportResult({ success: false, error: 'Import timed out. The file may be too large or the server is busy. Please try again or use a smaller date range.' });
      } else {
        setImportResult({ success: false, error: err.message || 'Network error - please check your connection and try again' });
      }
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

  useEffect(() => {
    const searchMembers = async () => {
      if (!searchQuery || searchQuery.length < 2) {
        setSearchResults([]);
        return;
      }
      setIsSearching(true);
      try {
        const res = await fetch(`/api/members/search?query=${encodeURIComponent(searchQuery)}&limit=20&includeFormer=true`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setSearchResults(data.map((m: any) => {
            const nameParts = (m.name || '').split(' ');
            return {
              ...m,
              firstName: nameParts[0] || '',
              lastName: nameParts.slice(1).join(' ') || '',
            };
          }));
        }
      } catch (err) {
        console.error('Member search error:', err);
      } finally {
        setIsSearching(false);
      }
    };
    const timeoutId = setTimeout(searchMembers, 300);
    return () => clearTimeout(timeoutId);
  }, [searchQuery]);

  const filteredMembers = searchQuery.length >= 2 ? searchResults : members.filter(m => {
    const query = searchQuery.toLowerCase();
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
            {importRuns.slice(0, 5).map((run: any, idx: number) => (
              <div key={run.id} className="p-3 bg-white/50 dark:bg-white/5 rounded-xl animate-slide-up-stagger" style={{ '--stagger-index': idx } as React.CSSProperties}>
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
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-primary dark:text-white flex items-center gap-2">
            <span aria-hidden="true" className="material-symbols-outlined">warning</span>
            Unmatched Bookings ({unmatchedTotalCount})
          </h2>
        </div>
        <p className="text-sm text-primary/70 dark:text-white/70 mb-4">
          These bookings have no owner assigned. The email or name from Trackman didn't match any member in our system. Click "Resolve" to link each booking to the correct member.
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
            {/* Mobile card view */}
            <div className="md:hidden space-y-3 max-h-[500px] overflow-y-auto">
              {unmatchedBookings
                .filter((booking: any) => {
                  if (!unmatchedSearchQuery.trim()) return true;
                  const query = unmatchedSearchQuery.toLowerCase();
                  const name = (booking.userName || booking.user_name || '').toLowerCase();
                  const email = (booking.originalEmail || booking.original_email || '').toLowerCase();
                  return name.includes(query) || email.includes(query);
                })
                .map((booking: any, idx: number) => (
                <div 
                  key={booking.id} 
                  className="bg-white/50 dark:bg-white/5 rounded-xl p-4 border border-primary/10 dark:border-white/10 animate-slide-up-stagger" 
                  style={{ '--stagger-index': idx } as React.CSSProperties}
                >
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <p className="font-bold text-primary dark:text-white">
                        {booking.userName || booking.user_name || 'Unknown'}
                      </p>
                      <p className="text-xs text-primary/60 dark:text-white/60 mt-0.5">
                        {booking.originalEmail || booking.original_email || 'No email'}
                      </p>
                    </div>
                    <span className="text-xs font-bold text-primary dark:text-white bg-primary/10 dark:bg-white/10 px-2 py-1 rounded-lg">
                      Bay {booking.bayNumber || booking.bay_number}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm mb-3">
                    <div>
                      <span className="text-xs text-primary/50 dark:text-white/50">Date</span>
                      <p className="text-primary dark:text-white font-medium text-sm">
                        {formatDateDisplayWithDay(booking.bookingDate || booking.booking_date)}
                      </p>
                    </div>
                    <div>
                      <span className="text-xs text-primary/50 dark:text-white/50">Time</span>
                      <p className="text-primary dark:text-white font-medium text-sm">
                        {(booking.startTime || booking.start_time)?.substring(0, 5)} - {(booking.endTime || booking.end_time)?.substring(0, 5)}
                      </p>
                    </div>
                  </div>
                  <div className="mb-3">
                    <span className="text-xs text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-500/10 px-2 py-1 rounded-full">
                      {booking.matchAttemptReason || booking.match_attempt_reason || 'No match'}
                    </span>
                  </div>
                  <button
                    onClick={() => setAssignPlayersModal({ booking, isOpen: true })}
                    className="w-full py-2 bg-accent text-primary rounded-lg text-sm font-bold hover:opacity-90 transition-opacity"
                  >
                    Resolve
                  </button>
                </div>
              ))}
            </div>

            {/* Desktop table view */}
            <div className="hidden md:block overflow-x-auto max-h-[500px] overflow-y-auto rounded-lg border border-primary/10 dark:border-white/10">
              <table className="w-full text-sm">
                <thead className="bg-white/80 dark:bg-white/10 sticky top-0 z-10">
                  <tr className="border-b border-primary/10 dark:border-white/10">
                    <th className="text-left py-2.5 px-3 font-semibold text-primary dark:text-white text-xs uppercase tracking-wide">Date/Time</th>
                    <th className="text-left py-2.5 px-3 font-semibold text-primary dark:text-white text-xs uppercase tracking-wide">Trackman Name</th>
                    <th className="text-left py-2.5 px-3 font-semibold text-primary dark:text-white text-xs uppercase tracking-wide">Email</th>
                    <th className="text-left py-2.5 px-3 font-semibold text-primary dark:text-white text-xs uppercase tracking-wide">Bay</th>
                    <th className="text-left py-2.5 px-3 font-semibold text-primary dark:text-white text-xs uppercase tracking-wide hidden lg:table-cell">Issue</th>
                    <th className="text-right py-2.5 px-3 font-semibold text-primary dark:text-white text-xs uppercase tracking-wide">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-primary/5 dark:divide-white/5">
                  {unmatchedBookings
                    .filter((booking: any) => {
                      if (!unmatchedSearchQuery.trim()) return true;
                      const query = unmatchedSearchQuery.toLowerCase();
                      const name = (booking.userName || booking.user_name || '').toLowerCase();
                      const email = (booking.originalEmail || booking.original_email || '').toLowerCase();
                      return name.includes(query) || email.includes(query);
                    })
                    .map((booking: any, idx: number) => (
                    <tr key={booking.id} className="bg-white/50 dark:bg-white/5 hover:bg-white/80 dark:hover:bg-white/10 transition-colors animate-slide-up-stagger" style={{ '--stagger-index': idx } as React.CSSProperties}>
                      <td className="py-2 px-3 text-primary dark:text-white whitespace-nowrap">
                        <div className="text-sm font-medium">{formatDateDisplayWithDay(booking.bookingDate || booking.booking_date)}</div>
                        <div className="text-xs text-primary/60 dark:text-white/60">{(booking.startTime || booking.start_time)?.substring(0, 5)} - {(booking.endTime || booking.end_time)?.substring(0, 5)}</div>
                      </td>
                      <td className="py-2 px-3 text-primary dark:text-white">
                        <div className="font-medium truncate max-w-[150px]">{booking.userName || booking.user_name || 'Unknown'}</div>
                      </td>
                      <td className="py-2 px-3 text-primary/80 dark:text-white/80">
                        <div className="truncate max-w-[180px]">{booking.originalEmail || booking.original_email || 'No email'}</div>
                      </td>
                      <td className="py-2 px-3 text-primary dark:text-white font-medium">{booking.bayNumber || booking.bay_number}</td>
                      <td className="py-2 px-3 hidden lg:table-cell">
                        <span className="text-xs text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-500/10 px-2 py-1 rounded-full truncate max-w-[200px] inline-block">
                          {booking.matchAttemptReason || booking.match_attempt_reason || 'No match'}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right">
                        <button
                          onClick={() => setAssignPlayersModal({ booking, isOpen: true })}
                          className="px-3 py-1.5 bg-accent text-primary rounded-lg text-xs font-bold hover:opacity-90 transition-opacity"
                        >
                          Resolve
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                      bookingId: booking.id,
                      bookingContext: {
                        ownerName: booking.userName || booking.user_name || 'Unknown',
                        resourceId: booking.resourceId || booking.resource_id,
                        requestDate: booking.requestDate || booking.request_date,
                        startTime: booking.startTime || booking.start_time || '',
                        endTime: booking.endTime || booking.end_time || '',
                        durationMinutes: booking.durationMinutes || booking.duration_minutes || 60,
                        notes: booking.notes || ''
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

      {managePlayersModal && (
        <ModalShell
          isOpen={!!managePlayersModal}
          onClose={() => setManagePlayersModal(null)}
          title="Manage Players"
          size="lg"
          showCloseButton={true}
        >
          <div className="p-4">
            <BookingMembersEditor
              bookingId={managePlayersModal.bookingId}
              bookingContext={managePlayersModal.bookingContext}
              showHeader={true}
              onMemberLinked={() => {
                fetchData();
              }}
            />
          </div>
          <div className="sticky bottom-0 p-4 border-t border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1d15]">
            <button
              onClick={() => setManagePlayersModal(null)}
              className="w-full py-2.5 bg-green-600 hover:bg-green-700 text-white text-sm font-bold rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-sm">check</span>
              Done
            </button>
          </div>
        </ModalShell>
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
              
              {fuzzyMatchModal?.selectedEmail && (fuzzyMatchModal.booking?.originalEmail || fuzzyMatchModal.booking?.original_email) && 
                (fuzzyMatchModal.booking?.originalEmail || fuzzyMatchModal.booking?.original_email).toLowerCase() !== fuzzyMatchModal.selectedEmail.toLowerCase() && (
                <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl border border-amber-200 dark:border-amber-500/30 mb-4">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={fuzzyMatchModal.rememberEmail}
                      onChange={(e) => setFuzzyMatchModal({ ...fuzzyMatchModal, rememberEmail: e.target.checked })}
                      className="mt-0.5 w-4 h-4 rounded border-amber-400 text-amber-500 focus:ring-amber-500/50 focus:ring-offset-0"
                    />
                    <div>
                      <p className="text-sm font-medium text-primary dark:text-white">Remember this email for future bookings</p>
                      <p className="text-xs text-primary/70 dark:text-white/70 mt-0.5">
                        Link "{fuzzyMatchModal.booking?.originalEmail || fuzzyMatchModal.booking?.original_email}" to this member's account
                      </p>
                    </div>
                  </label>
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

      {assignPlayersModal && (
        <TrackmanLinkModal
          isOpen={assignPlayersModal.isOpen}
          onClose={() => setAssignPlayersModal(null)}
          trackmanBookingId={assignPlayersModal.booking.trackmanBookingId || assignPlayersModal.booking.trackman_booking_id}
          bayName={`Bay ${assignPlayersModal.booking.bayNumber || assignPlayersModal.booking.bay_number}`}
          bookingDate={formatDateDisplayWithDay(assignPlayersModal.booking.bookingDate || assignPlayersModal.booking.booking_date)}
          timeSlot={`${assignPlayersModal.booking.startTime || assignPlayersModal.booking.start_time} - ${assignPlayersModal.booking.endTime || assignPlayersModal.booking.end_time}`}
          matchedBookingId={undefined}
          currentMemberName={undefined}
          currentMemberEmail={undefined}
          isRelink={false}
          onSuccess={async (options) => {
            const originalEmail = assignPlayersModal.booking.originalEmail || assignPlayersModal.booking.original_email;
            const memberEmail = options?.memberEmail;
            if (originalEmail && memberEmail) {
              try {
                await fetch('/api/admin/trackman/auto-resolve-same-email', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'include',
                  body: JSON.stringify({ 
                    originalEmail,
                    memberEmail,
                    excludeTrackmanId: assignPlayersModal.booking.trackmanBookingId || assignPlayersModal.booking.trackman_booking_id
                  })
                });
              } catch (err) {
                console.warn('Auto-resolve same email failed:', err);
              }
            }
            await new Promise(r => setTimeout(r, 300));
            fetchData();
          }}
          importedName={assignPlayersModal.booking.userName || assignPlayersModal.booking.user_name}
          notes={assignPlayersModal.booking.notes || assignPlayersModal.booking.note}
          isLegacyReview={false}
          originalEmail={assignPlayersModal.booking.originalEmail || assignPlayersModal.booking.original_email}
        />
      )}
    </div>
    </PullToRefresh>
  );
};

export default TrackmanTab;

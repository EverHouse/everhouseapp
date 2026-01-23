import React, { useState, useEffect, useRef, useCallback } from 'react';
import WalkingGolferSpinner from '../../WalkingGolferSpinner';
import TrackmanIcon from '../../icons/TrackmanIcon';

const ITEMS_PER_PAGE = 10;

const normalizeTimestamp = (dateStr: string): string => {
  if (!dateStr) return dateStr;
  let normalized = dateStr.replace(' ', 'T');
  if (!normalized.includes('Z') && !normalized.includes('+') && !/T[\d:]+[-+]/.test(normalized)) {
    normalized = normalized + 'Z';
  }
  return normalized;
};

const formatDateTimePacific = (dateStr: string): string => {
  const normalizedDateStr = normalizeTimestamp(dateStr);
  const date = new Date(normalizedDateStr);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/Los_Angeles'
  }) + ' at ' + date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Los_Angeles'
  });
};

const formatBookingDate = (dateStr: string): string => {
  if (!dateStr) return '';
  const date = new Date(normalizeTimestamp(dateStr));
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/Los_Angeles'
  });
};

const formatTimePacific = (dateStr: string): string => {
  if (!dateStr) return '';
  const date = new Date(normalizeTimestamp(dateStr));
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Los_Angeles'
  });
};

const formatTimeSlot = (startStr: string, endStr: string): string => {
  if (!startStr || !endStr) return '';
  return `${formatTimePacific(startStr)} - ${formatTimePacific(endStr)}`;
};

const calculateDuration = (startStr: string, endStr: string): string => {
  if (!startStr || !endStr) return '';
  const start = new Date(normalizeTimestamp(startStr));
  const end = new Date(normalizeTimestamp(endStr));
  const diffMs = end.getTime() - start.getTime();
  const diffMins = Math.round(diffMs / 60000);
  
  if (diffMins < 60) {
    return `${diffMins} min`;
  }
  const hours = diffMins / 60;
  if (hours === Math.floor(hours)) {
    return `${hours} hr${hours > 1 ? 's' : ''}`;
  }
  return `${hours.toFixed(1)} hrs`;
};

const getPlayerCount = (bookingData: any): number | null => {
  if (bookingData?.players && Array.isArray(bookingData.players)) {
    return bookingData.players.length;
  }
  if (typeof bookingData?.playerCount === 'number') {
    return bookingData.playerCount;
  }
  if (typeof bookingData?.player_count === 'number') {
    return bookingData.player_count;
  }
  return null;
};

const getEventTypeFromPayload = (payload: any, storedEventType: string): string => {
  // If we have a stored event type that's not unknown, use it
  if (storedEventType && storedEventType !== 'unknown') {
    return storedEventType;
  }
  
  // Try to determine event type from payload structure
  const booking = payload?.booking || payload?.data;
  if (booking) {
    // Check for cancellation indicators
    if (booking.cancelled || booking.canceled || booking.status === 'cancelled' || booking.status === 'canceled') {
      return 'cancelled';
    }
    // Check for update indicators (has updatedAt that differs from createdAt)
    if (booking.updatedAt && booking.createdAt && booking.updatedAt !== booking.createdAt) {
      return 'updated';
    }
    // Default to created for new bookings
    return 'created';
  }
  
  return storedEventType || 'webhook';
};

interface TrackmanWebhookEventsSectionProps {
  compact?: boolean;
  onLinkToMember?: (event: {
    trackmanBookingId: string;
    bayName?: string;
    bookingDate?: string;
    timeSlot?: string;
    duration?: string;
    matchedBookingId?: number;
    currentMemberName?: string;
    currentMemberEmail?: string;
    isRelink?: boolean;
  }) => void;
}

export const TrackmanWebhookEventsSection: React.FC<TrackmanWebhookEventsSectionProps> = ({ compact = true, onLinkToMember }) => {
  const [showSection, setShowSection] = useState(false);
  const [webhookEvents, setWebhookEvents] = useState<any[]>([]);
  const [webhookStats, setWebhookStats] = useState<any>(null);
  const [webhookPage, setWebhookPage] = useState(1);
  const [webhookTotalCount, setWebhookTotalCount] = useState(0);
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [expandedEventId, setExpandedEventId] = useState<number | null>(null);
  const sectionRef = useRef<HTMLDivElement>(null);

  const fetchWebhookEvents = useCallback(async (page: number) => {
    setWebhookLoading(true);
    try {
      const offset = (page - 1) * ITEMS_PER_PAGE;
      const cacheBuster = `_t=${Date.now()}`;
      const res = await fetch(`/api/admin/trackman-webhooks?limit=${ITEMS_PER_PAGE}&offset=${offset}&${cacheBuster}`, { credentials: 'include' });
      if (res.ok) {
        const result = await res.json();
        setWebhookEvents(result.events || []);
        setWebhookTotalCount(result.totalCount || 0);
      }
    } catch (err) {
      console.error('Failed to fetch webhook events:', err);
    } finally {
      setWebhookLoading(false);
    }
  }, []);

  const fetchWebhookStats = useCallback(async () => {
    try {
      const cacheBuster = `_t=${Date.now()}`;
      const res = await fetch(`/api/admin/trackman-webhooks/stats?${cacheBuster}`, { credentials: 'include' });
      if (res.ok) {
        const result = await res.json();
        setWebhookStats(result);
      }
    } catch (err) {
      console.error('Failed to fetch webhook stats:', err);
    }
  }, []);

  useEffect(() => {
    fetchWebhookStats();
  }, [fetchWebhookStats]);

  useEffect(() => {
    const handleBookingActionCompleted = () => {
      fetchWebhookStats();
      if (showSection) {
        fetchWebhookEvents(webhookPage);
      }
    };
    
    window.addEventListener('booking-action-completed', handleBookingActionCompleted);
    return () => window.removeEventListener('booking-action-completed', handleBookingActionCompleted);
  }, [fetchWebhookStats, fetchWebhookEvents, showSection, webhookPage]);

  const handleToggle = () => {
    setShowSection(!showSection);
    if (!showSection && webhookEvents.length === 0) {
      fetchWebhookEvents(1);
    }
  };

  const getEventBadgeColor = (type: string) => {
    if (type.includes('created') || type.includes('create')) return 'bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-400';
    if (type.includes('updated') || type.includes('update')) return 'bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-400';
    if (type.includes('cancelled') || type.includes('cancel') || type.includes('deleted')) return 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-400';
    return 'bg-gray-100 text-gray-800 dark:bg-white/10 dark:text-white/80';
  };

  const totalPages = Math.ceil(webhookTotalCount / ITEMS_PER_PAGE);

  return (
    <div ref={sectionRef} className="glass-card p-4 md:p-6 rounded-2xl border border-primary/10 dark:border-white/25">
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between"
      >
        <h2 className="text-base md:text-lg font-bold text-primary dark:text-white flex items-center gap-2">
          <TrackmanIcon size={22} />
          Trackman Bookings Synced
          {webhookStats?.webhookStats?.total_events > 0 && (
            <span className="text-xs md:text-sm font-normal text-primary/60 dark:text-white/60">
              ({webhookStats.webhookStats.total_events} in last 30 days)
            </span>
          )}
        </h2>
        <span aria-hidden="true" className={`material-symbols-outlined text-primary/60 dark:text-white/60 transition-transform ${showSection ? 'rotate-180' : ''}`}>
          expand_more
        </span>
      </button>

      {showSection && (
        <div className="mt-4 space-y-4">
          <p className="text-xs md:text-sm text-primary/70 dark:text-white/70">
            Real-time webhook events received from Trackman. These events automatically update bay availability and booking status.
          </p>

          {webhookStats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
              <div className="p-2 md:p-3 bg-white/50 dark:bg-white/5 rounded-xl text-center">
                <p className="text-xl md:text-2xl font-bold text-blue-600 dark:text-blue-400">
                  {webhookStats.webhookStats?.auto_confirmed || 0}
                </p>
                <p className="text-xs text-primary/60 dark:text-white/60">Auto Confirmed</p>
              </div>
              <div className="p-2 md:p-3 bg-white/50 dark:bg-white/5 rounded-xl text-center">
                <p className="text-xl md:text-2xl font-bold text-green-600 dark:text-green-400">
                  {webhookStats.webhookStats?.manually_linked || 0}
                </p>
                <p className="text-xs text-primary/60 dark:text-white/60">Manually Linked</p>
              </div>
              <div className="p-2 md:p-3 bg-white/50 dark:bg-white/5 rounded-xl text-center">
                <p className="text-xl md:text-2xl font-bold text-amber-600 dark:text-amber-400">
                  {webhookStats.webhookStats?.unmatched || 0}
                </p>
                <p className="text-xs text-primary/60 dark:text-white/60">Needs Linking</p>
              </div>
              <div className="p-2 md:p-3 bg-white/50 dark:bg-white/5 rounded-xl text-center">
                <p className="text-xl md:text-2xl font-bold text-red-600 dark:text-red-400">
                  {webhookStats.webhookStats?.cancelled || 0}
                </p>
                <p className="text-xs text-primary/60 dark:text-white/60">Cancelled</p>
              </div>
            </div>
          )}

          {webhookStats?.webhookStats?.last_event_at && (
            <p className="text-xs text-primary/60 dark:text-white/60">
              Last event: {formatDateTimePacific(webhookStats.webhookStats.last_event_at)}
            </p>
          )}

          {webhookLoading ? (
            <div className="py-8 flex justify-center">
              <WalkingGolferSpinner size="md" />
            </div>
          ) : webhookEvents.length === 0 ? (
            <div className="py-6 md:py-8 text-center border-2 border-dashed border-primary/10 dark:border-white/25 rounded-xl">
              <span aria-hidden="true" className="material-symbols-outlined text-3xl md:text-4xl text-primary/20 dark:text-white/20 mb-2">inbox</span>
              <p className="text-sm md:text-base text-primary/70 dark:text-white/70">No webhook events received yet</p>
              <p className="text-xs text-primary/50 dark:text-white/50 mt-1">
                Events will appear here once Trackman sends booking updates
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className={`space-y-2 ${compact ? 'max-h-[300px]' : 'max-h-[500px]'} overflow-y-auto`}>
                {webhookEvents.map((event: any) => {
                  const hasError = !!event.processing_error;
                  const isExpanded = expandedEventId === event.id;
                  
                  const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
                  const eventType = getEventTypeFromPayload(payload, event.event_type);
                  const bookingData = payload?.data || payload?.booking || {};
                  const bayName = bookingData?.bay_name || bookingData?.bayName || (bookingData?.bay?.ref ? `Bay ${bookingData.bay.ref}` : undefined);
                  
                  const bookingStart = bookingData?.start;
                  const bookingEnd = bookingData?.end;
                  const bookingDate = formatBookingDate(bookingStart);
                  const timeSlot = formatTimeSlot(bookingStart, bookingEnd);
                  const duration = calculateDuration(bookingStart, bookingEnd);
                  const playerCount = getPlayerCount(bookingData);

                  return (
                    <div key={event.id} className="p-3 md:p-4 bg-white/50 dark:bg-white/5 rounded-xl">
                      <div className="flex items-start justify-between gap-2 md:gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 md:gap-2 flex-wrap">
                            <span className={`px-1.5 md:px-2 py-0.5 rounded-full text-xs font-medium ${getEventBadgeColor(eventType)}`}>
                              {eventType}
                            </span>
                            {bayName && (
                              <span className="flex items-center gap-1 text-xs font-medium text-primary/80 dark:text-white/80">
                                <span className="material-symbols-outlined text-sm">sports_golf</span>
                                {bayName}
                              </span>
                            )}
                            {hasError && (
                              <span className="px-1.5 md:px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-400 flex items-center gap-0.5 md:gap-1">
                                <span className="material-symbols-outlined text-xs">error</span>
                                Error
                              </span>
                            )}
                            {event.matched_booking_id && !event.linked_booking_unmatched && (
                              <span className={`px-1.5 md:px-2 py-0.5 rounded-full text-xs font-medium flex items-center gap-0.5 md:gap-1 ${
                                event.was_auto_linked 
                                  ? 'bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-400'
                                  : 'bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-400'
                              }`}>
                                <span className="material-symbols-outlined text-xs">{event.was_auto_linked ? 'auto_awesome' : 'link'}</span>
                                {event.was_auto_linked ? 'Auto-Linked' : 'Linked'}
                              </span>
                            )}
                          </div>
                          
                          {(bookingDate || timeSlot) && (
                            <div className="mt-2 flex items-center gap-2 md:gap-3 flex-wrap">
                              {bookingDate && (
                                <span className="flex items-center gap-1 text-sm font-semibold text-primary dark:text-white">
                                  <span className="material-symbols-outlined text-base">calendar_today</span>
                                  {bookingDate}
                                </span>
                              )}
                              {timeSlot && (
                                <span className="flex items-center gap-1 text-sm font-semibold text-primary dark:text-white">
                                  <span className="material-symbols-outlined text-base">schedule</span>
                                  {timeSlot}
                                </span>
                              )}
                            </div>
                          )}
                          
                          <div className="mt-1.5 flex items-center gap-2 md:gap-3 text-xs text-primary/60 dark:text-white/60 flex-wrap">
                            {duration && (
                              <span className="flex items-center gap-0.5">
                                <span className="material-symbols-outlined text-sm">timer</span>
                                {duration}
                              </span>
                            )}
                            {playerCount !== null && (
                              <span className="flex items-center gap-0.5">
                                <span className="material-symbols-outlined text-sm">group</span>
                                {playerCount} player{playerCount !== 1 ? 's' : ''}
                              </span>
                            )}
                            <span className="flex items-center gap-0.5" title="Synced at">
                              <span className="material-symbols-outlined text-sm">sync</span>
                              {event.created_at ? formatDateTimePacific(event.created_at) : 'Unknown'}
                            </span>
                            {event.trackman_booking_id && (
                              <span className="text-primary/40 dark:text-white/40">
                                #{event.trackman_booking_id}
                              </span>
                            )}
                          </div>
                          
                          {hasError && (
                            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                              {event.processing_error}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {onLinkToMember && event.trackman_booking_id && (
                            (() => {
                              const isLinkedToMember = event.matched_booking_id && !event.linked_booking_unmatched;
                              const isLinkedButUnmatched = event.matched_booking_id && event.linked_booking_unmatched;
                              const memberDisplayName = event.linked_member_name && event.linked_member_name !== 'Unknown (Trackman)' 
                                ? event.linked_member_name 
                                : null;
                              
                              if (isLinkedToMember && memberDisplayName) {
                                const isAutoLinked = event.was_auto_linked;
                                return (
                                  <button
                                    onClick={() => onLinkToMember({
                                      trackmanBookingId: event.trackman_booking_id,
                                      bayName,
                                      bookingDate,
                                      timeSlot,
                                      duration,
                                      matchedBookingId: event.matched_booking_id,
                                      currentMemberName: event.linked_member_name,
                                      currentMemberEmail: event.linked_member_email,
                                      isRelink: true
                                    })}
                                    className={`px-2 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1 ${
                                      isAutoLinked 
                                        ? 'bg-blue-100 hover:bg-blue-200 text-blue-800 dark:bg-blue-500/20 dark:hover:bg-blue-500/30 dark:text-blue-400'
                                        : 'bg-green-100 hover:bg-green-200 text-green-800 dark:bg-green-500/20 dark:hover:bg-green-500/30 dark:text-green-400'
                                    }`}
                                    title={isAutoLinked ? "Auto-linked from existing request (click to change)" : "Manually linked (click to change)"}
                                  >
                                    <span className="material-symbols-outlined text-sm">person</span>
                                    <span className="hidden sm:inline truncate max-w-[100px]">{memberDisplayName}</span>
                                  </button>
                                );
                              } else if (isLinkedButUnmatched) {
                                return (
                                  <button
                                    onClick={() => onLinkToMember({
                                      trackmanBookingId: event.trackman_booking_id,
                                      bayName,
                                      bookingDate,
                                      timeSlot,
                                      duration,
                                      matchedBookingId: event.matched_booking_id,
                                      isRelink: true
                                    })}
                                    className="px-2 py-1.5 rounded-lg text-xs font-medium bg-amber-100 hover:bg-amber-200 text-amber-800 dark:bg-amber-500/20 dark:hover:bg-amber-500/30 dark:text-amber-400 transition-colors flex items-center gap-1"
                                    title="Link this Trackman booking to a member"
                                  >
                                    <span className="material-symbols-outlined text-sm">person_add</span>
                                    <span className="hidden sm:inline">Link to Member</span>
                                  </button>
                                );
                              } else if (!event.matched_booking_id) {
                                return (
                                  <button
                                    onClick={() => onLinkToMember({
                                      trackmanBookingId: event.trackman_booking_id,
                                      bayName,
                                      bookingDate,
                                      timeSlot,
                                      duration
                                    })}
                                    className="px-2 py-1.5 rounded-lg text-xs font-medium bg-amber-100 hover:bg-amber-200 text-amber-800 dark:bg-amber-500/20 dark:hover:bg-amber-500/30 dark:text-amber-400 transition-colors flex items-center gap-1"
                                    title="Link this Trackman booking to a member"
                                  >
                                    <span className="material-symbols-outlined text-sm">person_add</span>
                                    <span className="hidden sm:inline">Link to Member</span>
                                  </button>
                                );
                              }
                              return null;
                            })()
                          )}
                          <button
                            onClick={() => setExpandedEventId(isExpanded ? null : event.id)}
                            className="p-1.5 md:p-2 rounded-lg hover:bg-primary/10 dark:hover:bg-white/10 transition-colors shrink-0"
                            title={isExpanded ? 'Hide payload' : 'Show payload'}
                          >
                            <span className={`material-symbols-outlined text-primary/60 dark:text-white/60 transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
                              expand_more
                            </span>
                          </button>
                        </div>
                      </div>
                      
                      {isExpanded && (
                        <div className="mt-3 p-2 md:p-3 bg-gray-100 dark:bg-black/20 rounded-lg overflow-auto max-h-48 md:max-h-64">
                          <pre className="text-xs text-primary/80 dark:text-white/80 whitespace-pre-wrap break-all">
                            {JSON.stringify(payload, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-3 border-t border-primary/10 dark:border-white/10">
                  <p className="text-xs text-primary/60 dark:text-white/60">
                    Page {webhookPage} of {totalPages} ({webhookTotalCount} total)
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => { 
                        const newPage = Math.max(1, webhookPage - 1);
                        setWebhookPage(newPage); 
                        fetchWebhookEvents(newPage); 
                        sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); 
                      }}
                      disabled={webhookPage <= 1 || webhookLoading}
                      className="px-2 md:px-3 py-1 md:py-1.5 rounded-lg text-xs font-medium bg-primary/10 dark:bg-white/10 text-primary dark:text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/20 dark:hover:bg-white/20 transition-colors"
                    >
                      Previous
                    </button>
                    <button
                      onClick={() => { 
                        const newPage = Math.min(totalPages, webhookPage + 1);
                        setWebhookPage(newPage); 
                        fetchWebhookEvents(newPage); 
                        sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); 
                      }}
                      disabled={webhookPage >= totalPages || webhookLoading}
                      className="px-2 md:px-3 py-1 md:py-1.5 rounded-lg text-xs font-medium bg-primary/10 dark:bg-white/10 text-primary dark:text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/20 dark:hover:bg-white/20 transition-colors"
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
  );
};

export default TrackmanWebhookEventsSection;

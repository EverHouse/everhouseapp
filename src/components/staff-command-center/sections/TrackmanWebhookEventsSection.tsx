import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import WalkingGolferSpinner from '../../WalkingGolferSpinner';
import TrackmanIcon from '../../icons/TrackmanIcon';
import { fetchWithCredentials, postWithCredentials } from '../../../hooks/queries/useFetch';

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


interface TrackmanWebhookEvent {
  id: number | string;
  event_type?: string;
  payload?: Record<string, unknown>;
  created_at?: string;
  processed?: boolean;
  booking_id?: number;
  status?: string;
  processing_error?: string;
  matched_booking_id?: number;
  linked_booking_unmatched?: boolean;
  was_auto_linked?: boolean;
  trackman_booking_id?: string | number;
  linked_member_name?: string;
  linked_member_email?: string;
}

interface WebhookStats {
  total?: number;
  processed?: number;
  unprocessed?: number;
  byType?: Record<string, number>;
  webhookStats?: {
    total?: number;
    total_events?: number;
    matched?: number;
    unmatched?: number;
    cancelled?: number;
    errors?: number;
    auto_confirmed?: number;
    manually_linked?: number;
    needs_linking?: number;
    last_event_at?: string;
    byEventType?: Record<string, number>;
  };
}


interface TrackmanPayloadBooking {
  cancelled?: boolean;
  canceled?: boolean;
  status?: string;
  updatedAt?: string;
  createdAt?: string;
  created_at?: string;
  bay_name?: string;
  bayName?: string;
  bay?: { ref?: string; name?: string; id?: number };
  start?: string;
  end?: string;
  players?: unknown[];
  playerCount?: number;
  player_count?: number;
  type?: string;
  id?: number;
  range?: { id?: number; name?: string };
  bayOption?: { id?: number; name?: string; duration?: number; subtitle?: string | null };
  playerOptions?: Array<{ id?: number; name?: string; count?: number }>;
  externalBookingId?: string;
  externalBookingProvider?: string;
  venue?: { id?: number; name?: string; slug?: string };
}

const getPlayerCount = (bookingData: TrackmanPayloadBooking): number | null => {
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

const getEventTypeFromPayload = (payload: Record<string, unknown>, storedEventType: string): string => {
  // If we have a stored event type that's not unknown, use it
  if (storedEventType && storedEventType !== 'unknown') {
    return storedEventType;
  }
  
  // Try to determine event type from payload structure
  const booking = (payload?.booking || payload?.data) as TrackmanPayloadBooking | undefined;
  if (booking) {
    if (booking.cancelled || booking.canceled || booking.status === 'cancelled' || booking.status === 'canceled') {
      return 'cancelled';
    }
    if (booking.updatedAt && booking.createdAt && booking.updatedAt !== booking.createdAt) {
      return 'updated';
    }
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
  const [webhookEventsRef] = useAutoAnimate();
  const [showSection, setShowSection] = useState(false);
  const [webhookEvents, setWebhookEvents] = useState<TrackmanWebhookEvent[]>([]);
  const [webhookStats, setWebhookStats] = useState<WebhookStats | null>(null);
  const [webhookPage, setWebhookPage] = useState(1);
  const [webhookTotalCount, setWebhookTotalCount] = useState(0);
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [expandedEventId, setExpandedEventId] = useState<number | string | null>(null);
  const [autoMatchingEventId, setAutoMatchingEventId] = useState<number | null>(null);
  const [autoMatchResult, setAutoMatchResult] = useState<{ eventId: number; success: boolean; message: string } | null>(null);
  const [showReplayModal, setShowReplayModal] = useState(false);
  const [replayDevUrl, setReplayDevUrl] = useState('');
  const [replayLimit, setReplayLimit] = useState(100);
  const [isReplaying, setIsReplaying] = useState(false);
  const [replayResult, setReplayResult] = useState<{ success: boolean; message: string; sent?: number; failed?: number } | null>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  const autoMatchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (autoMatchTimeoutRef.current) clearTimeout(autoMatchTimeoutRef.current);
    };
  }, []);

  const replayMutation = useMutation({
    mutationFn: (body: { dev_url: string; limit: number }) =>
      postWithCredentials<{ message?: string; sent?: number; failed?: number; error?: string; details?: string }>('/api/trackman/replay-webhooks-to-dev', body),
  });

  const handleReplayToDev = async () => {
    if (!replayDevUrl) return;
    
    setIsReplaying(true);
    setReplayResult(null);
    
    replayMutation.mutate(
      { dev_url: replayDevUrl, limit: replayLimit },
      {
        onSuccess: (result) => {
          setReplayResult({
            success: true,
            message: result.message || 'Replay complete',
            sent: result.sent,
            failed: result.failed
          });
        },
        onError: (err: unknown) => {
          setReplayResult({
            success: false,
            message: (err instanceof Error ? err.message : String(err)) || 'Network error'
          });
        },
        onSettled: () => setIsReplaying(false),
      }
    );
  };

  const fetchWebhookEvents = useCallback(async (page: number) => {
    setWebhookLoading(true);
    try {
      const offset = (page - 1) * ITEMS_PER_PAGE;
      const cacheBuster = `_t=${Date.now()}`;
      const result = await fetchWithCredentials<{ events: TrackmanWebhookEvent[]; totalCount: number }>(`/api/admin/trackman-webhooks?limit=${ITEMS_PER_PAGE}&offset=${offset}&${cacheBuster}`);
      setWebhookEvents(result.events || []);
      setWebhookTotalCount(result.totalCount || 0);
    } catch (err: unknown) {
      console.error('Failed to fetch webhook events:', err);
    } finally {
      setWebhookLoading(false);
    }
  }, []);

  const fetchWebhookStats = useCallback(async () => {
    try {
      const cacheBuster = `_t=${Date.now()}`;
      const result = await fetchWithCredentials<Record<string, unknown>>(`/api/admin/trackman-webhooks/stats?${cacheBuster}`);
      setWebhookStats(result);
    } catch (err: unknown) {
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
    if (type.includes('block_cancelled')) return 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-400';
    if (type.includes('block')) return 'bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-400';
    if (type.includes('user_update') || type.includes('user.')) return 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-400';
    if (type.includes('purchase')) return 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-400';
    if (type.includes('modified')) return 'bg-purple-100 text-purple-800 dark:bg-purple-500/20 dark:text-purple-400';
    if (type.includes('created') || type.includes('create')) return 'bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-400';
    if (type.includes('updated') || type.includes('update')) return 'bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-400';
    if (type.includes('cancelled') || type.includes('cancel') || type.includes('deleted')) return 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-400';
    return 'bg-gray-100 text-gray-800 dark:bg-white/10 dark:text-white/80';
  };

  const handleAutoMatch = useCallback(async (eventId: number) => {
    setAutoMatchingEventId(eventId);
    setAutoMatchResult(null);
    
    try {
      const result = await postWithCredentials<{ success: boolean; message?: string }>(`/api/admin/trackman-webhook/${eventId}/auto-match`, {});
      
      setAutoMatchResult({
        eventId,
        success: result.success,
        message: result.message || (result.success ? 'Matched!' : 'No match found')
      });
      
      if (result.success) {
        fetchWebhookEvents(webhookPage);
        fetchWebhookStats();
        window.dispatchEvent(new CustomEvent('booking-action-completed'));
      }
      
      if (autoMatchTimeoutRef.current) clearTimeout(autoMatchTimeoutRef.current);
      autoMatchTimeoutRef.current = setTimeout(() => setAutoMatchResult(null), 5000);
    } catch (_err: unknown) {
      setAutoMatchResult({
        eventId,
        success: false,
        message: 'Network error - try again'
      });
      if (autoMatchTimeoutRef.current) clearTimeout(autoMatchTimeoutRef.current);
      autoMatchTimeoutRef.current = setTimeout(() => setAutoMatchResult(null), 5000);
    } finally {
      setAutoMatchingEventId(null);
    }
  }, [fetchWebhookEvents, fetchWebhookStats, webhookPage]);

  const totalPages = Math.ceil(webhookTotalCount / ITEMS_PER_PAGE);

  return (
    <div ref={sectionRef} className="glass-card p-4 md:p-6 rounded-xl border border-primary/10 dark:border-white/25">
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between"
      >
        <h2 className="text-2xl leading-tight font-bold text-primary dark:text-white flex items-center gap-2" style={{ fontFamily: 'var(--font-headline)' }}>
          <TrackmanIcon size={22} />
          Trackman Bookings Synced
          {(webhookStats?.webhookStats?.total_events ?? 0) > 0 && (
            <span className="text-xs md:text-sm font-normal text-primary/60 dark:text-white/60">
              ({webhookStats?.webhookStats?.total_events} in last 30 days)
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
                  {webhookStats.webhookStats?.needs_linking || 0}
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
              <div ref={webhookEventsRef} className={`space-y-2 ${compact ? 'max-h-[300px]' : 'max-h-[500px]'} overflow-y-auto`}>
                {webhookEvents.map((event: TrackmanWebhookEvent) => {

                  const hasError = !!event.processing_error;
                  const isExpanded = expandedEventId === event.id;
                  
                  const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
                  const eventType = getEventTypeFromPayload(payload, event.event_type ?? '') ?? '';
                  const isUserUpdate = eventType === 'user_update' || eventType === 'user.updated' || eventType === 'user.created';
                  const isPurchaseUpdate = eventType === 'purchase_update' || eventType === 'purchase_paid' || eventType.includes('purchase');
                  const userData = isUserUpdate ? (payload?.user || payload?.data || payload) as Record<string, unknown> : null;
                  const purchaseData = isPurchaseUpdate ? (payload?.purchase || payload?.data || payload) as Record<string, unknown> : null;
                  const bookingData = (!isUserUpdate && !isPurchaseUpdate) ? (payload?.data || payload?.booking || {}) as TrackmanPayloadBooking : {} as TrackmanPayloadBooking;
                  const venueData = (payload?.venue || bookingData?.venue) as TrackmanPayloadBooking['venue'];
                  const bayName = bookingData?.bay_name || bookingData?.bayName || (bookingData?.bay?.ref ? `Bay ${bookingData.bay.ref}` : undefined);
                  
                  const bookingStart = bookingData?.start;
                  const bookingEnd = bookingData?.end;
                  const bookingDate = formatBookingDate(bookingStart ?? '');
                  const timeSlot = formatTimeSlot(bookingStart ?? '', bookingEnd ?? '');
                  const duration = calculateDuration(bookingStart ?? '', bookingEnd ?? '');
                  const playerCount = getPlayerCount(bookingData);

                  const userDisplayName = userData ? [userData.firstName || userData.first_name, userData.lastName || userData.last_name].filter(Boolean).join(' ') as string : '';
                  const userEmail = (userData?.email as string) || '';
                  const userPhone = (userData?.phone || userData?.phoneNumber || userData?.mobile) as string || '';
                  const trackmanUserId = (userData?.id || userData?.userId) as string || '';

                  return (
                    <div key={event.id} className="p-3 md:p-4 bg-white/50 dark:bg-white/5 rounded-xl tactile-row">
                      <div className="flex items-start justify-between gap-2 md:gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 md:gap-2 flex-wrap">
                            <span className={`px-1.5 md:px-2 py-0.5 rounded-[4px] text-xs font-medium ${getEventBadgeColor(eventType)}`}>
                              {eventType}
                            </span>
                            {isUserUpdate && (
                              <span className="flex items-center gap-1 text-xs font-medium text-primary/80 dark:text-white/80">
                                <span className="material-symbols-outlined text-sm">person</span>
                                {userDisplayName || userEmail || 'User'}
                              </span>
                            )}
                            {isPurchaseUpdate && (
                              <span className="flex items-center gap-1 text-xs font-medium text-primary/80 dark:text-white/80">
                                <span className="material-symbols-outlined text-sm">receipt_long</span>
                                Purchase
                              </span>
                            )}
                            {!isUserUpdate && !isPurchaseUpdate && bayName && (
                              <span className="flex items-center gap-1 text-xs font-medium text-primary/80 dark:text-white/80">
                                <span className="material-symbols-outlined text-sm">sports_golf</span>
                                {bayName}
                              </span>
                            )}
                            {hasError && (
                              <span className="px-1.5 md:px-2 py-0.5 rounded-[4px] text-xs font-medium bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-400 flex items-center gap-0.5 md:gap-1">
                                <span className="material-symbols-outlined text-xs">error</span>
                                Error
                              </span>
                            )}
                            {event.matched_booking_id && !event.linked_booking_unmatched && (
                              <span className={`px-1.5 md:px-2 py-0.5 rounded-[4px] text-xs font-medium flex items-center gap-0.5 md:gap-1 ${
                                event.was_auto_linked 
                                  ? 'bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-400'
                                  : 'bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-400'
                              }`}>
                                <span className="material-symbols-outlined text-xs">{event.was_auto_linked ? 'auto_awesome' : 'link'}</span>
                                {event.was_auto_linked ? 'Automated' : 'Linked'}
                              </span>
                            )}
                          </div>
                          
                          {isUserUpdate && (userEmail || userPhone) && (
                            <div className="mt-2 flex items-center gap-2 md:gap-3 flex-wrap">
                              {userEmail && (
                                <span className="flex items-center gap-1 text-sm font-semibold text-primary dark:text-white">
                                  <span className="material-symbols-outlined text-base">mail</span>
                                  {userEmail}
                                </span>
                              )}
                              {userPhone && (
                                <span className="flex items-center gap-1 text-sm font-semibold text-primary dark:text-white">
                                  <span className="material-symbols-outlined text-base">phone</span>
                                  {userPhone}
                                </span>
                              )}
                            </div>
                          )}

                          {!isUserUpdate && !isPurchaseUpdate && (bookingDate || timeSlot) && (
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
                            {!isUserUpdate && !isPurchaseUpdate && duration && (
                              <span className="flex items-center gap-0.5">
                                <span className="material-symbols-outlined text-sm">timer</span>
                                {duration}
                              </span>
                            )}
                            {!isUserUpdate && !isPurchaseUpdate && playerCount !== null && (
                              <span className="flex items-center gap-0.5">
                                <span className="material-symbols-outlined text-sm">group</span>
                                {playerCount} player{playerCount !== 1 ? 's' : ''}
                              </span>
                            )}
                            <span className="flex items-center gap-0.5" title="Synced at">
                              <span className="material-symbols-outlined text-sm">sync</span>
                              {event.created_at ? formatDateTimePacific(event.created_at) : 'Unknown'}
                            </span>
                            {isUserUpdate && trackmanUserId && (
                              <span className="text-primary/40 dark:text-white/40">
                                User #{trackmanUserId}
                              </span>
                            )}
                            {!isUserUpdate && event.trackman_booking_id && (
                              <span className="text-primary/40 dark:text-white/40">
                                #{event.trackman_booking_id}
                              </span>
                            )}
                          </div>
                          
                          {hasError && (
                            <p className="mt-1 text-xs text-red-600 dark:text-red-400 break-words">
                              {event.processing_error}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {onLinkToMember && event.trackman_booking_id && !isUserUpdate && !isPurchaseUpdate && (
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
                                      trackmanBookingId: String(event.trackman_booking_id),
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
                                const isAutoMatching = autoMatchingEventId === event.id;
                                const matchResult = autoMatchResult?.eventId === event.id ? autoMatchResult : null;
                                return (
                                  <div className="flex flex-wrap items-center gap-1">
                                    {matchResult && (
                                      <span className={`text-xs max-w-[180px] break-words ${matchResult.success ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}>
                                        {matchResult.message}
                                      </span>
                                    )}
                                    <button
                                      onClick={() => handleAutoMatch(event.id as number)}
                                      disabled={isAutoMatching}
                                      className="px-2 py-1.5 rounded-lg text-xs font-medium bg-blue-100 hover:bg-blue-200 text-blue-800 dark:bg-blue-500/20 dark:hover:bg-blue-500/30 dark:text-blue-400 transition-colors flex items-center gap-1 disabled:opacity-50"
                                      title="Try to auto-match this booking to an existing request by bay, date, and time"
                                    >
                                      <span className="material-symbols-outlined text-sm">{isAutoMatching ? 'sync' : 'auto_awesome'}</span>
                                      <span className="hidden sm:inline">{isAutoMatching ? 'Matching...' : 'Auto Match'}</span>
                                    </button>
                                    <button
                                      onClick={() => onLinkToMember({
                                        trackmanBookingId: String(event.trackman_booking_id),
                                        bayName,
                                        bookingDate,
                                        timeSlot,
                                        duration,
                                        matchedBookingId: event.matched_booking_id,
                                        isRelink: true
                                      })}
                                      className="px-2 py-1.5 rounded-lg text-xs font-medium bg-amber-100 hover:bg-amber-200 text-amber-800 dark:bg-amber-500/20 dark:hover:bg-amber-500/30 dark:text-amber-400 transition-colors flex items-center gap-1"
                                      title="Manually link this Trackman booking to a member"
                                    >
                                      <span className="material-symbols-outlined text-sm">person_add</span>
                                      <span className="hidden sm:inline">Link</span>
                                    </button>
                                  </div>
                                );
                              } else if (!event.matched_booking_id) {
                                const isAutoMatching = autoMatchingEventId === event.id;
                                const matchResult = autoMatchResult?.eventId === event.id ? autoMatchResult : null;
                                return (
                                  <div className="flex flex-wrap items-center gap-1">
                                    {matchResult && (
                                      <span className={`text-xs max-w-[180px] break-words ${matchResult.success ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}>
                                        {matchResult.message}
                                      </span>
                                    )}
                                    <button
                                      onClick={() => handleAutoMatch(event.id as number)}
                                      disabled={isAutoMatching}
                                      className="px-2 py-1.5 rounded-lg text-xs font-medium bg-blue-100 hover:bg-blue-200 text-blue-800 dark:bg-blue-500/20 dark:hover:bg-blue-500/30 dark:text-blue-400 transition-colors flex items-center gap-1 disabled:opacity-50"
                                      title="Try to auto-match this booking to an existing request by bay, date, and time"
                                    >
                                      <span className="material-symbols-outlined text-sm">{isAutoMatching ? 'sync' : 'auto_awesome'}</span>
                                      <span className="hidden sm:inline">{isAutoMatching ? 'Matching...' : 'Auto Match'}</span>
                                    </button>
                                    <button
                                      onClick={() => onLinkToMember({
                                        trackmanBookingId: String(event.trackman_booking_id),
                                        bayName,
                                        bookingDate,
                                        timeSlot,
                                        duration
                                      })}
                                      className="px-2 py-1.5 rounded-lg text-xs font-medium bg-amber-100 hover:bg-amber-200 text-amber-800 dark:bg-amber-500/20 dark:hover:bg-amber-500/30 dark:text-amber-400 transition-colors flex items-center gap-1"
                                      title="Manually link this Trackman booking to a member"
                                    >
                                      <span className="material-symbols-outlined text-sm">person_add</span>
                                      <span className="hidden sm:inline">Link</span>
                                    </button>
                                  </div>
                                );
                              }
                              return null;
                            })()
                          )}
                          <button
                            onClick={() => setExpandedEventId(isExpanded ? null : event.id)}
                            aria-expanded={isExpanded}
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
                        <div className="mt-3 space-y-2">
                          {isUserUpdate && userData ? (
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                            {trackmanUserId && (
                              <div className="p-2 bg-indigo-50 dark:bg-indigo-500/10 rounded-lg">
                                <p className="text-[10px] uppercase tracking-wider text-indigo-600/60 dark:text-indigo-400/60">Trackman User ID</p>
                                <p className="text-xs font-medium text-indigo-800 dark:text-indigo-300">{trackmanUserId}</p>
                              </div>
                            )}
                            {userDisplayName && (
                              <div className="p-2 bg-indigo-50 dark:bg-indigo-500/10 rounded-lg">
                                <p className="text-[10px] uppercase tracking-wider text-indigo-600/60 dark:text-indigo-400/60">Name</p>
                                <p className="text-xs font-medium text-indigo-800 dark:text-indigo-300">{userDisplayName}</p>
                              </div>
                            )}
                            {userEmail && (
                              <div className="p-2 bg-indigo-50 dark:bg-indigo-500/10 rounded-lg">
                                <p className="text-[10px] uppercase tracking-wider text-indigo-600/60 dark:text-indigo-400/60">Email</p>
                                <p className="text-xs font-medium text-indigo-800 dark:text-indigo-300 break-all">{userEmail}</p>
                              </div>
                            )}
                            {userPhone && (
                              <div className="p-2 bg-indigo-50 dark:bg-indigo-500/10 rounded-lg">
                                <p className="text-[10px] uppercase tracking-wider text-indigo-600/60 dark:text-indigo-400/60">Phone</p>
                                <p className="text-xs font-medium text-indigo-800 dark:text-indigo-300">{userPhone}</p>
                              </div>
                            )}
                            {venueData?.name && (
                              <div className="p-2 bg-gray-50 dark:bg-white/5 rounded-lg">
                                <p className="text-[10px] uppercase tracking-wider text-primary/50 dark:text-white/40">Venue</p>
                                <p className="text-xs font-medium text-primary dark:text-white">{venueData.name}</p>
                              </div>
                            )}
                            {Object.entries(userData).filter(([k]) => !['id', 'userId', 'email', 'phone', 'phoneNumber', 'mobile', 'firstName', 'first_name', 'lastName', 'last_name'].includes(k) && typeof userData[k] !== 'object').map(([key, value]) => (
                              <div key={key} className="p-2 bg-gray-50 dark:bg-white/5 rounded-lg">
                                <p className="text-[10px] uppercase tracking-wider text-primary/50 dark:text-white/40">{key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim()}</p>
                                <p className="text-xs font-medium text-primary dark:text-white break-all">{String(value)}</p>
                              </div>
                            ))}
                          </div>
                          ) : isPurchaseUpdate && purchaseData ? (
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                            {!!purchaseData.id && (
                              <div className="p-2 bg-amber-50 dark:bg-amber-500/10 rounded-lg">
                                <p className="text-[10px] uppercase tracking-wider text-amber-600/60 dark:text-amber-400/60">Purchase ID</p>
                                <p className="text-xs font-medium text-amber-800 dark:text-amber-300">{String(purchaseData.id)}</p>
                              </div>
                            )}
                            {!!purchaseData.status && (
                              <div className="p-2 bg-amber-50 dark:bg-amber-500/10 rounded-lg">
                                <p className="text-[10px] uppercase tracking-wider text-amber-600/60 dark:text-amber-400/60">Status</p>
                                <p className="text-xs font-medium text-amber-800 dark:text-amber-300 capitalize">{String(purchaseData.status)}</p>
                              </div>
                            )}
                            {purchaseData.total !== undefined && (
                              <div className="p-2 bg-amber-50 dark:bg-amber-500/10 rounded-lg">
                                <p className="text-[10px] uppercase tracking-wider text-amber-600/60 dark:text-amber-400/60">Total</p>
                                <p className="text-xs font-medium text-amber-800 dark:text-amber-300">{String(purchaseData.total)}</p>
                              </div>
                            )}
                            {venueData?.name && (
                              <div className="p-2 bg-gray-50 dark:bg-white/5 rounded-lg">
                                <p className="text-[10px] uppercase tracking-wider text-primary/50 dark:text-white/40">Venue</p>
                                <p className="text-xs font-medium text-primary dark:text-white">{venueData.name}</p>
                              </div>
                            )}
                            {Array.isArray(purchaseData.lineItems || purchaseData.line_items) && (
                              <div className="p-2 bg-gray-50 dark:bg-white/5 rounded-lg col-span-2 md:col-span-3">
                                <p className="text-[10px] uppercase tracking-wider text-primary/50 dark:text-white/40 mb-1">Line Items</p>
                                <div className="flex flex-wrap gap-1.5">
                                  {((purchaseData.lineItems || purchaseData.line_items) as Array<Record<string, unknown>>).map((item, idx) => (
                                    <span key={idx} className="px-2 py-0.5 bg-white dark:bg-white/10 rounded text-xs text-primary dark:text-white">
                                      {String(item.name || item.type || `Item ${idx + 1}`)}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                          ) : (
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                            {bookingData?.id && (
                              <div className="p-2 bg-gray-50 dark:bg-white/5 rounded-lg">
                                <p className="text-[10px] uppercase tracking-wider text-primary/50 dark:text-white/40">Trackman ID</p>
                                <p className="text-xs font-medium text-primary dark:text-white">{bookingData.id}</p>
                              </div>
                            )}
                            {bookingData?.status && (
                              <div className="p-2 bg-gray-50 dark:bg-white/5 rounded-lg">
                                <p className="text-[10px] uppercase tracking-wider text-primary/50 dark:text-white/40">Status</p>
                                <p className="text-xs font-medium text-primary dark:text-white capitalize">{bookingData.status}</p>
                              </div>
                            )}
                            {(() => {
                              const rawOpts = bookingData?.playerOptions as Record<string, { quantity?: number; name?: string }> | Array<{ quantity?: number; name?: string }> | undefined;
                              const optsArr = Array.isArray(rawOpts) ? rawOpts : rawOpts ? Object.values(rawOpts) : [];
                              const memberQty = optsArr.reduce((sum: number, opt) => sum + (Number(opt?.quantity) || 0), 0);
                              const firstName = optsArr[0]?.name;
                              return memberQty > 0 ? (
                                <div className="p-2 bg-gray-50 dark:bg-white/5 rounded-lg">
                                  <p className="text-[10px] uppercase tracking-wider text-primary/50 dark:text-white/40">Players</p>
                                  <p className="text-xs font-medium text-primary dark:text-white">{memberQty} {firstName ? `x ${firstName}` : ''}</p>
                                </div>
                              ) : bookingData?.type ? (
                                <div className="p-2 bg-gray-50 dark:bg-white/5 rounded-lg">
                                  <p className="text-[10px] uppercase tracking-wider text-primary/50 dark:text-white/40">Type</p>
                                  <p className="text-xs font-medium text-primary dark:text-white">{bookingData.type}</p>
                                </div>
                              ) : null;
                            })()}
                            {bookingData?.bayOption?.name && (
                              <div className="p-2 bg-gray-50 dark:bg-white/5 rounded-lg">
                                <p className="text-[10px] uppercase tracking-wider text-primary/50 dark:text-white/40">Bay Option</p>
                                <p className="text-xs font-medium text-primary dark:text-white">{bookingData.bayOption.name}</p>
                                {bookingData.bayOption.duration && (
                                  <p className="text-[10px] text-primary/50 dark:text-white/40">{bookingData.bayOption.duration} hr{bookingData.bayOption.duration !== 1 ? 's' : ''}</p>
                                )}
                              </div>
                            )}
                            {bookingData?.bay && (
                              <div className="p-2 bg-gray-50 dark:bg-white/5 rounded-lg">
                                <p className="text-[10px] uppercase tracking-wider text-primary/50 dark:text-white/40">Bay</p>
                                <p className="text-xs font-medium text-primary dark:text-white">
                                  {bookingData.bay.name || (bookingData.bay.ref ? `Bay ${bookingData.bay.ref}` : `ID: ${bookingData.bay.id}`)}
                                </p>
                              </div>
                            )}
                            {venueData?.name && (
                              <div className="p-2 bg-gray-50 dark:bg-white/5 rounded-lg">
                                <p className="text-[10px] uppercase tracking-wider text-primary/50 dark:text-white/40">Venue</p>
                                <p className="text-xs font-medium text-primary dark:text-white">{venueData.name}</p>
                              </div>
                            )}
                            {(bookingData?.createdAt || bookingData?.created_at) && (
                              <div className="p-2 bg-gray-50 dark:bg-white/5 rounded-lg">
                                <p className="text-[10px] uppercase tracking-wider text-primary/50 dark:text-white/40">Created</p>
                                <p className="text-xs font-medium text-primary dark:text-white">{formatDateTimePacific(bookingData.createdAt || bookingData.created_at || '')}</p>
                              </div>
                            )}
                            {bookingData?.externalBookingId && (
                              <div className="p-2 bg-gray-50 dark:bg-white/5 rounded-lg">
                                <p className="text-[10px] uppercase tracking-wider text-primary/50 dark:text-white/40">External Booking</p>
                                <p className="text-xs font-medium text-primary dark:text-white">#{bookingData.externalBookingId}</p>
                              </div>
                            )}
                            {event.matched_booking_id && (
                              <div className="p-2 bg-gray-50 dark:bg-white/5 rounded-lg">
                                <p className="text-[10px] uppercase tracking-wider text-primary/50 dark:text-white/40">Linked Booking</p>
                                <p className="text-xs font-medium text-primary dark:text-white">#{event.matched_booking_id}</p>
                              </div>
                            )}
                          </div>
                          )}
                          {bookingData?.playerOptions && bookingData.playerOptions.length > 0 && (
                            <div className="p-2 bg-gray-50 dark:bg-white/5 rounded-lg">
                              <p className="text-[10px] uppercase tracking-wider text-primary/50 dark:text-white/40 mb-1">Player Options</p>
                              <div className="flex flex-wrap gap-1.5">
                                {bookingData.playerOptions.map((po, idx) => (
                                  <span key={idx} className="px-2 py-0.5 bg-white dark:bg-white/10 rounded text-xs text-primary dark:text-white">
                                    {po.name || `Option ${idx + 1}`}{po.count ? ` (x${po.count})` : ''}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {event.linked_member_name && event.linked_member_name !== 'Unknown (Trackman)' && (
                            <div className="p-2 bg-green-50 dark:bg-green-500/10 rounded-lg">
                              <p className="text-[10px] uppercase tracking-wider text-green-600/60 dark:text-green-400/60 mb-0.5">Linked Member</p>
                              <p className="text-xs font-medium text-green-800 dark:text-green-300">{event.linked_member_name}</p>
                              {event.linked_member_email && (
                                <p className="text-[10px] text-green-600/60 dark:text-green-400/60">{event.linked_member_email}</p>
                              )}
                            </div>
                          )}
                          <details className="group">
                            <summary className="text-[10px] uppercase tracking-wider text-primary/40 dark:text-white/30 cursor-pointer hover:text-primary/60 dark:hover:text-white/50 transition-colors">
                              Raw Payload
                            </summary>
                            <div className="mt-1 p-2 bg-gray-100 dark:bg-black/20 rounded-lg overflow-auto max-h-48">
                              <pre className="text-[10px] text-primary/70 dark:text-white/60 whitespace-pre-wrap break-all">
                                {JSON.stringify(payload, null, 2)}
                              </pre>
                            </div>
                          </details>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Always show total count, pagination buttons only when multiple pages */}
              <div className="flex items-center justify-between pt-3 border-t border-primary/10 dark:border-white/10">
                <p className="text-xs text-primary/60 dark:text-white/60">
                  {totalPages > 1 ? `Page ${webhookPage} of ${totalPages} (${webhookTotalCount} total)` : `${webhookTotalCount} webhook${webhookTotalCount !== 1 ? 's' : ''} received`}
                </p>
                {totalPages > 1 && (
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
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {showReplayModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setShowReplayModal(false)} role="button" tabIndex={0} aria-label="Close dialog" onKeyDown={(e) => { if (e.key === 'Escape') setShowReplayModal(false); }}>
          <div className="w-full max-w-md bg-white dark:bg-gray-800 rounded-xl shadow-xl p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-primary dark:text-white">Replay Webhooks to Dev</h3>
              <button onClick={() => setShowReplayModal(false)} className="p-1 hover:bg-gray-100 dark:hover:bg-white/10 rounded-full" aria-label="Close">
                <span className="material-symbols-outlined text-gray-500">close</span>
              </button>
            </div>
            
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Send all stored Trackman webhook events to your development environment for testing.
            </p>
            
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Dev Webhook URL
                </label>
                <input
                  type="url"
                  value={replayDevUrl}
                  onChange={e => setReplayDevUrl(e.target.value)}
                  placeholder="https://your-dev-app.replit.app/api/webhooks/trackman"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-primary dark:text-white placeholder:text-gray-400 text-sm"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Limit (max events to send)
                </label>
                <input
                  type="number"
                  value={replayLimit}
                  onChange={e => setReplayLimit(parseInt(e.target.value) || 100)}
                  min={1}
                  max={500}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-primary dark:text-white text-sm"
                />
              </div>
            </div>
            
            {replayResult && (
              <div className={`p-3 rounded-lg text-sm ${replayResult.success ? 'bg-green-100 dark:bg-green-500/20 text-green-800 dark:text-green-300' : 'bg-red-100 dark:bg-red-500/20 text-red-800 dark:text-red-300'}`}>
                <p className="font-medium">{replayResult.message}</p>
                {replayResult.sent !== undefined && (
                  <p className="text-xs mt-1">Sent: {replayResult.sent} | Failed: {replayResult.failed}</p>
                )}
              </div>
            )}
            
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setShowReplayModal(false)}
                className="flex-1 py-2 px-4 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 font-medium hover:bg-gray-50 dark:hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                onClick={handleReplayToDev}
                disabled={!replayDevUrl || isReplaying}
                className="flex-1 py-2 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400 text-white rounded-lg font-medium flex items-center justify-center gap-2"
              >
                {isReplaying ? (
                  <>
                    <span className="animate-spin material-symbols-outlined text-sm">refresh</span>
                    Sending...
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-sm">send</span>
                    Replay All
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TrackmanWebhookEventsSection;

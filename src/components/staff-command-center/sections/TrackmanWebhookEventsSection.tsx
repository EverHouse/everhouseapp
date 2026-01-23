import React, { useState, useEffect, useRef, useCallback } from 'react';
import WalkingGolferSpinner from '../../WalkingGolferSpinner';

const ITEMS_PER_PAGE = 10;

const formatDateTimePacific = (dateStr: string): string => {
  // Ensure the timestamp is treated as UTC if no timezone indicator present
  let normalizedDateStr = dateStr;
  if (dateStr && !dateStr.includes('Z') && !dateStr.includes('+') && !dateStr.includes('-', 10)) {
    normalizedDateStr = dateStr + 'Z';
  }
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

interface TrackmanWebhookEventsSectionProps {
  compact?: boolean;
}

export const TrackmanWebhookEventsSection: React.FC<TrackmanWebhookEventsSectionProps> = ({ compact = true }) => {
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
          <span aria-hidden="true" className="material-symbols-outlined text-xl">webhook</span>
          Trackman Webhook Events
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
                <p className="text-xl md:text-2xl font-bold text-primary dark:text-white">
                  {webhookStats.webhookStats?.total_events || 0}
                </p>
                <p className="text-xs text-primary/60 dark:text-white/60">Total Events</p>
              </div>
              <div className="p-2 md:p-3 bg-white/50 dark:bg-white/5 rounded-xl text-center">
                <p className="text-xl md:text-2xl font-bold text-green-600 dark:text-green-400">
                  {webhookStats.webhookStats?.auto_approved || 0}
                </p>
                <p className="text-xs text-primary/60 dark:text-white/60">Auto-Approved</p>
              </div>
              <div className="p-2 md:p-3 bg-white/50 dark:bg-white/5 rounded-xl text-center">
                <p className="text-xl md:text-2xl font-bold text-blue-600 dark:text-blue-400">
                  {webhookStats.webhookStats?.booking_updates || 0}
                </p>
                <p className="text-xs text-primary/60 dark:text-white/60">Booking Updates</p>
              </div>
              <div className="p-2 md:p-3 bg-white/50 dark:bg-white/5 rounded-xl text-center">
                <p className="text-xl md:text-2xl font-bold text-red-600 dark:text-red-400">
                  {webhookStats.webhookStats?.errors || 0}
                </p>
                <p className="text-xs text-primary/60 dark:text-white/60">Errors</p>
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
                  const eventType = event.event_type || 'unknown';
                  const hasError = !!event.processing_error;
                  const isExpanded = expandedEventId === event.id;
                  
                  const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
                  const bookingData = payload?.data || payload?.booking || {};
                  const bayName = bookingData?.bay_name || bookingData?.bayName || (bookingData?.bay?.ref ? `Bay ${bookingData.bay.ref}` : undefined);

                  return (
                    <div key={event.id} className="p-3 md:p-4 bg-white/50 dark:bg-white/5 rounded-xl">
                      <div className="flex items-start justify-between gap-2 md:gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 md:gap-2 flex-wrap">
                            <span className={`px-1.5 md:px-2 py-0.5 rounded-full text-xs font-medium ${getEventBadgeColor(eventType)}`}>
                              {eventType}
                            </span>
                            {hasError && (
                              <span className="px-1.5 md:px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-400 flex items-center gap-0.5 md:gap-1">
                                <span className="material-symbols-outlined text-xs">error</span>
                                Error
                              </span>
                            )}
                            {event.matched_booking_id && (
                              <span className="px-1.5 md:px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-400 flex items-center gap-0.5 md:gap-1">
                                <span className="material-symbols-outlined text-xs">link</span>
                                Linked
                              </span>
                            )}
                          </div>
                          <div className="mt-1.5 md:mt-2 flex items-center gap-2 md:gap-3 text-xs text-primary/70 dark:text-white/70 flex-wrap">
                            <span className="flex items-center gap-0.5 md:gap-1">
                              <span className="material-symbols-outlined text-sm">schedule</span>
                              {event.created_at ? formatDateTimePacific(event.created_at) : 'Unknown time'}
                            </span>
                            {bayName && (
                              <span className="flex items-center gap-0.5 md:gap-1">
                                <span className="material-symbols-outlined text-sm">sports_golf</span>
                                {bayName}
                              </span>
                            )}
                            {event.trackman_booking_id && (
                              <span className="text-primary/50 dark:text-white/50">
                                ID: {event.trackman_booking_id}
                              </span>
                            )}
                          </div>
                          {hasError && (
                            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                              {event.processing_error}
                            </p>
                          )}
                        </div>
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

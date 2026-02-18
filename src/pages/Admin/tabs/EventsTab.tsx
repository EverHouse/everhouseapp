import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../../components/Toast';
import PullToRefresh from '../../../components/PullToRefresh';
import FloatingActionButton from '../../../components/FloatingActionButton';
import PageErrorBoundary from '../../../components/PageErrorBoundary';
import { EventsAdminContent } from './events/EventsAdminContent';
import { WellnessAdminContent } from './events/WellnessAdminContent';

const EventsTab: React.FC = () => {
    const { showToast } = useToast();
    const queryClient = useQueryClient();
    const [searchParams, setSearchParams] = useSearchParams();
    const subtabParam = searchParams.get('subtab');
    const activeSubTab: 'events' | 'wellness' = subtabParam === 'wellness' ? 'wellness' : 'events';
    const [syncMessage, setSyncMessage] = useState<string | null>(null);
    
    const setActiveSubTab = (tab: 'events' | 'wellness') => {
        setSearchParams(prev => {
            const newParams = new URLSearchParams(prev);
            if (tab === 'events') {
                newParams.delete('subtab');
            } else {
                newParams.set('subtab', tab);
            }
            return newParams;
        }, { replace: true });
    };

    const syncMutation = useMutation({
        mutationFn: async () => {
            const maxRetries = 3;
            const retryFetch = async (url: string, attempt = 1): Promise<Response> => {
                try {
                    return await fetch(url, { method: 'POST', credentials: 'include' });
                } catch (err: unknown) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    if (attempt < maxRetries && (errMsg?.includes('fetch') || errMsg?.includes('network'))) {
                        await new Promise(r => setTimeout(r, 500 * attempt));
                        return retryFetch(url, attempt + 1);
                    }
                    throw err;
                }
            };
            
            const [calRes, ebRes] = await Promise.all([
                retryFetch('/api/calendars/sync-all'),
                retryFetch('/api/eventbrite/sync')
            ]);
            
            const calData = await calRes.json();
            const ebData = await ebRes.json();
            
            return { calRes, ebRes, calData, ebData };
        },
        onSuccess: ({ calRes, ebRes, calData, ebData }) => {
            queryClient.invalidateQueries({ queryKey: ['admin-events'] });
            queryClient.invalidateQueries({ queryKey: ['events-needs-review'] });
            queryClient.invalidateQueries({ queryKey: ['wellness-classes'] });
            queryClient.invalidateQueries({ queryKey: ['wellness-needs-review'] });
            
            window.dispatchEvent(new CustomEvent('refreshEventsData'));
            window.dispatchEvent(new CustomEvent('refreshWellnessData'));
            
            const errors: string[] = [];
            if (!calRes.ok) errors.push('Google Calendar');
            if (!ebRes.ok && !ebData.skipped) errors.push('Eventbrite');
            
            if (errors.length === 0) {
                const parts: string[] = [];
                if (calData.events?.synced) parts.push(`${calData.events.synced} events`);
                if (calData.wellness?.synced) parts.push(`${calData.wellness.synced} wellness`);
                setSyncMessage(parts.length > 0 ? `Synced ${parts.join(', ')}` : 'Sync complete');
            } else {
                setSyncMessage(`Sync failed for: ${errors.join(', ')}`);
            }
            setTimeout(() => setSyncMessage(null), 5000);
        },
        onError: () => {
            setSyncMessage('Network error - please try again');
            setTimeout(() => setSyncMessage(null), 5000);
        }
    });
    
    const handlePullRefresh = async () => {
        setSyncMessage(null);
        syncMutation.mutate();
    };

    return (
        <PullToRefresh onRefresh={handlePullRefresh}>
            <div className="animate-pop-in backdrop-blur-sm">
                {syncMessage && (
                    <div className={`mb-4 px-4 py-2 rounded-lg text-sm font-medium ${
                        syncMessage.startsWith('Error') || syncMessage.startsWith('Failed') || syncMessage.startsWith('Some syncs') || syncMessage.includes('failed')
                            ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800' 
                            : 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 border border-green-200 dark:border-green-800'
                    }`}>
                        {syncMessage}
                    </div>
                )}

                <div className="flex gap-2 mb-4 animate-slide-up-stagger" style={{ '--stagger-index': 0 } as React.CSSProperties}>
                    <button
                        type="button"
                        onClick={() => setActiveSubTab('events')}
                        style={{ touchAction: 'manipulation' }}
                        className={`tactile-btn flex-1 py-2.5 px-3 rounded-lg font-bold text-sm transition-all duration-fast flex items-center justify-center gap-1.5 ${
                            activeSubTab === 'events'
                                ? 'bg-primary dark:bg-primary text-white shadow-md'
                                : 'bg-white/60 dark:bg-white/10 text-gray-600 dark:text-white/80 border border-gray-200 dark:border-white/25'
                        }`}
                    >
                        <span aria-hidden="true" className="material-symbols-outlined text-[18px]">event</span>
                        Events
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveSubTab('wellness')}
                        style={{ touchAction: 'manipulation' }}
                        className={`tactile-btn flex-1 py-2.5 px-3 rounded-lg font-bold text-sm transition-all duration-fast flex items-center justify-center gap-1.5 ${
                            activeSubTab === 'wellness'
                                ? 'bg-accent text-primary shadow-md'
                                : 'bg-white/60 dark:bg-white/10 text-gray-600 dark:text-white/80 border border-gray-200 dark:border-white/25'
                        }`}
                    >
                        <span aria-hidden="true" className="material-symbols-outlined text-[18px]">spa</span>
                        Wellness
                    </button>
                </div>

                <div key={activeSubTab} className="animate-content-enter">
                    {activeSubTab === 'events' && <PageErrorBoundary pageName="EventsTab"><EventsAdminContent /></PageErrorBoundary>}
                    {activeSubTab === 'wellness' && <PageErrorBoundary pageName="WellnessTab"><WellnessAdminContent /></PageErrorBoundary>}
                </div>
                <FloatingActionButton 
                    onClick={() => {
                        if (activeSubTab === 'events') {
                            window.dispatchEvent(new CustomEvent('openEventCreate'));
                        } else {
                            window.dispatchEvent(new CustomEvent('openWellnessCreate'));
                        }
                    }} 
                    color={activeSubTab === 'events' ? 'green' : 'purple'} 
                    label={activeSubTab === 'events' ? 'Add event' : 'Add wellness session'} 
                />
            </div>
        </PullToRefresh>
    );
};

export default EventsTab;

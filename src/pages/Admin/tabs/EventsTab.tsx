import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../../lib/apiRequest';
import { useToast } from '../../../components/Toast';
import FloatingActionButton from '../../../components/FloatingActionButton';
import PageErrorBoundary from '../../../components/PageErrorBoundary';
import { EventsAdminContent } from './events/EventsAdminContent';
import { WellnessAdminContent } from './events/WellnessAdminContent';
import Icon from '../../../components/icons/Icon';

const EventsTab: React.FC = () => {
    const { showToast } = useToast();
    const queryClient = useQueryClient();
    const [searchParams, setSearchParams] = useSearchParams();
    const subtabParam = searchParams.get('subtab');
    const activeSubTab: 'events' | 'wellness' = subtabParam === 'wellness' ? 'wellness' : 'events';
    
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

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const syncMutation = useMutation({
        mutationFn: async () => {
            const retryConfig = { maxRetries: 3, retryNonIdempotent: true, baseDelay: 500 };
            const [calRes, ebRes] = await Promise.all([
                apiRequest<Record<string, unknown>>('/api/calendars/sync-all', { method: 'POST' }, retryConfig),
                apiRequest<Record<string, unknown>>('/api/eventbrite/sync', { method: 'POST' }, retryConfig)
            ]);
            return { calRes, ebRes };
        },
        onSuccess: ({ calRes, ebRes }) => {
            queryClient.invalidateQueries({ queryKey: ['admin-events'] });
            queryClient.invalidateQueries({ queryKey: ['events-needs-review'] });
            queryClient.invalidateQueries({ queryKey: ['wellness-classes'] });
            queryClient.invalidateQueries({ queryKey: ['wellness-needs-review'] });
            
            window.dispatchEvent(new CustomEvent('refreshEventsData'));
            window.dispatchEvent(new CustomEvent('refreshWellnessData'));
            
            const errors: string[] = [];
            if (!calRes.ok) errors.push('Google Calendar');
            if (!ebRes.ok && !(ebRes.data as Record<string, unknown> | undefined)?.skipped) errors.push('Eventbrite');
            
            if (errors.length === 0) {
                const calData = calRes.data as Record<string, unknown> | undefined;
                const parts: string[] = [];
                const events = calData?.events as Record<string, unknown> | undefined;
                const wellness = calData?.wellness as Record<string, unknown> | undefined;
                if (events?.synced) parts.push(`${events.synced} events`);
                if (wellness?.synced) parts.push(`${wellness.synced} wellness`);
                showToast(parts.length > 0 ? `Synced ${parts.join(', ')}` : 'Sync complete', 'success');
            } else {
                showToast(`Sync failed for: ${errors.join(', ')}`, 'error');
            }
        },
        onError: () => {
            showToast('Network error - please try again', 'error');
        }
    });
    
    return (
            <div className="animate-page-enter backdrop-blur-sm">
                <div className="flex gap-2 mb-4 animate-content-enter-delay-1">
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
                        <Icon name="event" className="text-[18px]" />
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
                        <Icon name="spa" className="text-[18px]" />
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
                    extended
                    text={activeSubTab === 'events' ? 'Add Event' : 'Add Session'}
                />
            </div>
    );
};

export default EventsTab;

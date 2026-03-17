import React from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import EmptyState from '../../../../components/EmptyState';
import FloatingActionButton from '../../../../components/FloatingActionButton';
import type { MembershipTier } from './tiersTypes';

interface TierCardListProps {
    tiers: MembershipTier[];
    stripeConnection: { mode?: string } | null | undefined;
    syncStripePending: boolean;
    pullFromStripePending: boolean;
    openEdit: (tier: MembershipTier) => void;
    openCreate: () => void;
    handleSyncStripe: () => void;
    handlePullFromStripe: () => void;
}

const TierCardList: React.FC<TierCardListProps> = ({
    tiers,
    stripeConnection,
    syncStripePending,
    pullFromStripePending,
    openEdit,
    openCreate,
    handleSyncStripe,
    handlePullFromStripe,
}) => {
    const [tiersRef] = useAutoAnimate();
    const subscriptionTiers = tiers.filter(t => t.product_type !== 'one_time');

    return (
        <>
            <div className="flex justify-between items-center mb-4">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400">
                    Membership Tiers
                </h3>
                <div className="flex items-center gap-2">
                    {stripeConnection?.mode && (
                        <span className={`flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-[4px] ${
                            stripeConnection.mode === 'live' 
                                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' 
                                : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                        }`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${stripeConnection.mode === 'live' ? 'bg-green-500' : 'bg-amber-500'}`} />
                            Stripe {stripeConnection.mode === 'live' ? 'Live' : 'Test'}
                        </span>
                    )}
                    <button
                        onClick={handlePullFromStripe}
                        disabled={pullFromStripePending}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/20 rounded-lg hover:bg-purple-100 dark:hover:bg-purple-900/30 transition-colors disabled:opacity-50"
                    >
                        <span aria-hidden="true" className={`material-symbols-outlined text-sm ${pullFromStripePending ? 'animate-spin' : ''}`}>
                            {pullFromStripePending ? 'progress_activity' : 'cloud_download'}
                        </span>
                        {pullFromStripePending ? 'Pulling...' : 'Pull from Stripe'}
                    </button>
                    <button
                        onClick={handleSyncStripe}
                        disabled={syncStripePending}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/20 rounded-lg hover:bg-indigo-100 dark:hover:bg-indigo-900/30 transition-colors disabled:opacity-50"
                    >
                        <span aria-hidden="true" className={`material-symbols-outlined text-sm ${syncStripePending ? 'animate-spin' : ''}`}>
                            {syncStripePending ? 'progress_activity' : 'sync'}
                        </span>
                        {syncStripePending ? 'Syncing...' : 'Sync to Stripe'}
                    </button>
                </div>
            </div>
            {subscriptionTiers.length === 0 ? (
                <EmptyState
                    icon="workspace_premium"
                    title="No tiers found"
                    description="Membership tiers will appear here once configured"
                    variant="compact"
                />
            ) : (
                <div ref={tiersRef} className="space-y-3 animate-content-enter">
                    {subscriptionTiers.map((tier) => (
                        <div 
                            key={tier.id} 
                            onClick={() => openEdit(tier)}
                            className="bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border border-gray-200 dark:border-white/20 cursor-pointer hover:border-primary/30 transition-colors tactile-card"
                        >
                            <div className="flex items-start justify-between mb-3">
                                <div>
                                    <div className="flex items-center gap-2 mb-1">
                                        <h4 className="font-bold text-lg text-primary dark:text-white">{tier.name}</h4>
                                        {tier.is_popular && (
                                            <span className="text-[10px] font-bold uppercase tracking-wider bg-accent text-primary px-2 py-0.5 rounded">Popular</span>
                                        )}
                                        {!tier.is_active && (
                                            <span className="text-[10px] font-bold uppercase tracking-wider bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-0.5 rounded">Inactive</span>
                                        )}
                                    </div>
                                    <p className="text-xl font-bold text-primary dark:text-white">{tier.price_string}</p>
                                </div>
                                <button aria-label="Edit tier" className="text-gray-600 hover:text-primary dark:hover:text-white transition-colors">
                                    <span aria-hidden="true" className="material-symbols-outlined">edit</span>
                                </button>
                            </div>
                            
                            {tier.description && (
                                <p className="text-sm text-gray-500 dark:text-gray-400 mb-3 line-clamp-2">{tier.description}</p>
                            )}
                            
                            <div className="flex flex-wrap gap-2 text-xs">
                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300">
                                    <span aria-hidden="true" className="material-symbols-outlined text-sm">sports_golf</span>
                                    {tier.daily_sim_minutes > 0 ? `${tier.daily_sim_minutes}min sim` : 'No sim'}
                                </span>
                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300">
                                    <span aria-hidden="true" className="material-symbols-outlined text-sm">person_add</span>
                                    {tier.guest_passes_per_month > 0 ? `${tier.guest_passes_per_month} passes` : 'No passes'}
                                </span>
                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300">
                                    <span aria-hidden="true" className="material-symbols-outlined text-sm">calendar_today</span>
                                    {tier.booking_window_days}d window
                                </span>
                                {tier.unlimited_access && (
                                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-primary/10 dark:bg-primary/20 text-primary dark:text-white font-bold">
                                        <span aria-hidden="true" className="material-symbols-outlined text-sm">all_inclusive</span>
                                        Unlimited
                                    </span>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
            <FloatingActionButton onClick={openCreate} icon="add" label="New Tier" />
        </>
    );
};

export default TierCardList;

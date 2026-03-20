import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchWithCredentials, putWithCredentials } from '../../../../hooks/queries/useFetch';
import type { MembershipTier } from './tiersTypes';
import Icon from '../../../../components/icons/Icon';
import { useToast } from '../../../../components/Toast';

interface FeesSubTabProps {
    tiers: MembershipTier[];
    openEdit: (tier: MembershipTier) => void;
}

interface PricingData {
    guestFeeDollars: number;
    overageRatePerBlockDollars: number;
    overageBlockMinutes: number;
}

interface PricingUpdateResponse extends PricingData {
    synced: boolean;
    syncError?: string;
}

const FeesSubTab: React.FC<FeesSubTabProps> = ({ tiers, openEdit }) => {
    const oneTimePasses = tiers.filter(t => t.product_type === 'one_time');
    const { showToast } = useToast();
    const queryClient = useQueryClient();

    const { data: pricing, isLoading: pricingLoading } = useQuery({
        queryKey: ['pricing-config'],
        queryFn: () => fetchWithCredentials<PricingData>('/api/pricing'),
        staleTime: 5 * 60 * 1000,
    });

    const [guestFee, setGuestFee] = useState<string>('');
    const [overageRate, setOverageRate] = useState<string>('');
    const [isDirty, setIsDirty] = useState(false);

    useEffect(() => {
        if (pricing) {
            setGuestFee(pricing.guestFeeDollars.toFixed(2));
            setOverageRate(pricing.overageRatePerBlockDollars.toFixed(2));
            setIsDirty(false);
        }
    }, [pricing]);

    const [lastSyncResult, setLastSyncResult] = useState<{ synced: boolean; error?: string } | null>(null);

    const updatePricingMutation = useMutation({
        mutationFn: (data: { guestFeeDollars?: number; overageRatePerBlockDollars?: number }) =>
            putWithCredentials<PricingUpdateResponse>('/api/pricing', data),
        onSuccess: (data) => {
            queryClient.setQueryData(['pricing-config'], {
                guestFeeDollars: data.guestFeeDollars,
                overageRatePerBlockDollars: data.overageRatePerBlockDollars,
                overageBlockMinutes: data.overageBlockMinutes,
            });
            setIsDirty(false);
            setLastSyncResult({ synced: data.synced, error: data.syncError });
            showToast(
                data.synced ? 'Fees updated — synced to Stripe' : 'Fees saved locally — Stripe sync failed',
                data.synced ? 'success' : 'error'
            );
        },
        onError: (err: Error) => {
            setLastSyncResult(null);
            showToast(err.message || 'Failed to update fees', 'error');
        },
    });

    const handleSaveFees = () => {
        const guestFeeDollars = parseFloat(guestFee);
        const overageRatePerBlockDollars = parseFloat(overageRate);
        if (isNaN(guestFeeDollars) || isNaN(overageRatePerBlockDollars)) {
            showToast('Please enter valid dollar amounts', 'error');
            return;
        }
        updatePricingMutation.mutate({ guestFeeDollars, overageRatePerBlockDollars });
    };

    const handleGuestFeeChange = (val: string) => {
        setGuestFee(val);
        setIsDirty(true);
    };

    const handleOverageRateChange = (val: string) => {
        setOverageRate(val);
        setIsDirty(true);
    };

    return (
        <div className="space-y-6">
            <div>
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400">
                        Dynamic Fees
                    </h3>
                    {lastSyncResult && (
                        lastSyncResult.synced ? (
                            <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                                <Icon name="check_circle" className="text-sm" />
                                Synced
                            </span>
                        ) : (
                            <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400" title={lastSyncResult.error}>
                                <Icon name="error" className="text-sm" />
                                Sync failed
                            </span>
                        )
                    )}
                </div>
                {pricingLoading ? (
                    <div className="grid grid-cols-2 gap-3">
                        {[0, 1].map(i => (
                            <div key={i} className="p-4 rounded-xl bg-gray-100 dark:bg-white/5 animate-pulse h-20" />
                        ))}
                    </div>
                ) : pricing ? (
                    <>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="p-4 rounded-xl bg-white dark:bg-surface-dark border border-gray-200 dark:border-white/20 shadow-sm">
                                <div className="flex items-center gap-2 mb-2">
                                    <Icon name="person_add" className="text-base text-primary/60 dark:text-white/60" />
                                    <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Guest Fee</p>
                                </div>
                                <div className="flex items-center gap-1">
                                    <span className="text-lg font-bold text-primary dark:text-white">$</span>
                                    <input
                                        type="number"
                                        step="0.01"
                                        min="0"
                                        className="w-full text-2xl font-bold text-primary dark:text-white bg-transparent border-b-2 border-gray-200 dark:border-white/20 focus:border-primary dark:focus:border-white outline-none transition-colors py-0.5"
                                        value={guestFee}
                                        onChange={e => handleGuestFeeChange(e.target.value)}
                                    />
                                </div>
                                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1.5">per guest per session</p>
                            </div>
                            <div className="p-4 rounded-xl bg-white dark:bg-surface-dark border border-gray-200 dark:border-white/20 shadow-sm">
                                <div className="flex items-center gap-2 mb-2">
                                    <Icon name="timer" className="text-base text-primary/60 dark:text-white/60" />
                                    <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Overage Rate</p>
                                </div>
                                <div className="flex items-center gap-1">
                                    <span className="text-lg font-bold text-primary dark:text-white">$</span>
                                    <input
                                        type="number"
                                        step="0.01"
                                        min="0"
                                        className="w-full text-2xl font-bold text-primary dark:text-white bg-transparent border-b-2 border-gray-200 dark:border-white/20 focus:border-primary dark:focus:border-white outline-none transition-colors py-0.5"
                                        value={overageRate}
                                        onChange={e => handleOverageRateChange(e.target.value)}
                                    />
                                </div>
                                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1.5">per {pricing.overageBlockMinutes} min block</p>
                            </div>
                        </div>
                        {isDirty && (
                            <div className="flex items-center justify-between mt-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40">
                                <span className="text-xs text-amber-700 dark:text-amber-400">You have unsaved fee changes</span>
                                <button
                                    onClick={handleSaveFees}
                                    disabled={updatePricingMutation.isPending}
                                    className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-bold text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
                                >
                                    {updatePricingMutation.isPending && <Icon name="progress_activity" className="animate-spin text-sm" />}
                                    {updatePricingMutation.isPending ? 'Saving...' : 'Save Fees'}
                                </button>
                            </div>
                        )}
                    </>
                ) : (
                    <p className="text-xs text-gray-400 dark:text-gray-500">Could not load pricing data.</p>
                )}
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
                    Edit rates above and save — changes sync automatically.
                </p>
            </div>

            {oneTimePasses.length > 0 && (
                <div>
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400">
                            Day Passes & Guest Passes
                        </h3>
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                            {oneTimePasses.length} item{oneTimePasses.length !== 1 ? 's' : ''}
                        </span>
                    </div>
                    <div className="space-y-3">
                        {oneTimePasses.map((pass) => (
                            <div 
                                key={pass.id} 
                                role="button"
                                tabIndex={0}
                                onClick={() => openEdit(pass)}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEdit(pass); } }}
                                className="bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border border-gray-200 dark:border-white/20 cursor-pointer hover:border-primary/30 transition-all duration-fast"
                            >
                                <div className="flex items-start justify-between">
                                    <div>
                                        <div className="flex items-center gap-2 mb-1">
                                            <h4 className="font-bold text-lg text-primary dark:text-white">{pass.name}</h4>
                                            <span className="text-[10px] font-bold uppercase tracking-wider bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded">
                                                One-time
                                            </span>
                                            {!pass.is_active && (
                                                <span className="text-[10px] font-bold uppercase tracking-wider bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-0.5 rounded">Inactive</span>
                                            )}
                                        </div>
                                        <p className="text-xl font-bold text-primary dark:text-white">{pass.price_string}</p>
                                        {pass.description && (
                                            <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">{pass.description}</p>
                                        )}
                                    </div>
                                    <button aria-label="Edit pass" className="text-gray-600 hover:text-primary dark:hover:text-white transition-colors">
                                        <Icon name="edit" />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default FeesSubTab;

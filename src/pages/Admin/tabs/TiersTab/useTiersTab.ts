import { useState, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchWithCredentials, postWithCredentials, deleteWithCredentials, putWithCredentials } from '../../../../hooks/queries/useFetch';
import { useUndoAction } from '../../../../hooks/useUndoAction';
import { useToast } from '../../../../components/Toast';
import type { SubTab, MembershipTier, TierFeature, StripePrice, TierRecord } from './tiersTypes';

export function useTiersTab() {
    const queryClient = useQueryClient();
    const { showToast } = useToast();
    const [searchParams, setSearchParams] = useSearchParams();
    const subtabParam = searchParams.get('subtab');
    const activeSubTab: SubTab = subtabParam === 'fees' ? 'fees' : subtabParam === 'discounts' ? 'discounts' : subtabParam === 'cafe' ? 'cafe' : 'tiers';
    
    const setActiveSubTab = (tab: SubTab) => {
        setSearchParams(params => {
            const newParams = new URLSearchParams(params);
            if (tab === 'tiers') {
                newParams.delete('subtab');
            } else {
                newParams.set('subtab', tab);
            }
            return newParams;
        });
    };

    const [isEditing, setIsEditing] = useState(false);
    const [isCreating, setIsCreating] = useState(false);
    const [selectedTier, setSelectedTier] = useState<MembershipTier | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [editingLabelId, setEditingLabelId] = useState<number | null>(null);
    const [newFeatureForm, setNewFeatureForm] = useState({ key: '', label: '', type: 'boolean' as 'boolean' | 'number' | 'text' });
    const debounceTimers = useRef<Record<string, NodeJS.Timeout>>({});
    const { execute: undoAction } = useUndoAction();
    const [isReordering, setIsReordering] = useState(false);

    const { data: stripeConnection } = useQuery({
        queryKey: ['stripe-connection-mode'],
        queryFn: () => fetchWithCredentials<{ mode?: string }>('/api/stripe/debug-connection').catch(() => null),
        staleTime: 5 * 60 * 1000,
        retry: 1,
    });

    const { data: tiers = [], isLoading } = useQuery({
        queryKey: ['membership-tiers'],
        queryFn: async () => {
            const data = await fetchWithCredentials<TierRecord[]>('/api/membership-tiers');
            return data.map((t: TierRecord) => ({
                ...t,
                highlighted_features: Array.isArray(t.highlighted_features) ? t.highlighted_features : 
                    (typeof t.highlighted_features === 'string' ? JSON.parse(t.highlighted_features || '[]') : []),
                all_features: typeof t.all_features === 'object' && t.all_features !== null ? t.all_features :
                    (typeof t.all_features === 'string' ? JSON.parse(t.all_features || '{}') : {})
            })) as MembershipTier[];
        },
    });

    const { data: stripePrices = [], isLoading: loadingPrices } = useQuery({
        queryKey: ['stripe-prices-recurring'],
        queryFn: async () => {
            const data = await fetchWithCredentials<{ prices: StripePrice[] }>('/api/stripe/prices/recurring');
            return data.prices || [];
        },
    });

    const { data: tierFeatures = [], isLoading: featuresLoading } = useQuery({
        queryKey: ['tier-features'],
        queryFn: async () => {
            const data = await fetchWithCredentials<{ features: TierFeature[] }>('/api/tier-features');
            return data.features || [];
        },
        enabled: isEditing || isCreating,
    });

    const getDefaultTier = (): MembershipTier => ({
        id: 0,
        name: '',
        slug: '',
        price_string: '',
        description: '',
        button_text: 'Apply Now',
        sort_order: tiers.length,
        is_active: true,
        is_popular: false,
        show_in_comparison: true,
        show_on_membership_page: true,
        highlighted_features: [],
        all_features: {},
        daily_sim_minutes: 0,
        guest_passes_per_month: 0,
        booking_window_days: 7,
        daily_conf_room_minutes: 0,
        can_book_simulators: false,
        can_book_conference: false,
        can_book_wellness: true,
        has_group_lessons: false,
        has_extended_sessions: false,
        has_private_lesson: false,
        has_simulator_guest_passes: false,
        has_discounted_merch: false,
        unlimited_access: false,
        stripe_price_id: null,
        stripe_product_id: null,
        price_cents: null,
        wallet_pass_bg_color: null,
        wallet_pass_foreground_color: null,
        wallet_pass_label_color: null,
    });

    const saveTierMutation = useMutation({
        mutationFn: async ({ tier, isNew }: { tier: MembershipTier; isNew: boolean }) => {
            const url = isNew ? '/api/membership-tiers' : `/api/membership-tiers/${tier.id}`;
            const payload = isNew ? {
                ...tier,
                slug: tier.name.toLowerCase().replace(/\s+/g, '-'),
            } : tier;
            return fetchWithCredentials<MembershipTier>(url, {
                method: isNew ? 'POST' : 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        },
        onMutate: async () => {
            await queryClient.cancelQueries({ queryKey: ['membership-tiers'] });
        },
        onSuccess: () => {
            setSuccessMessage(`Tier ${isCreating ? 'created' : 'updated'} successfully`);
            setTimeout(() => {
                setIsEditing(false);
                setIsCreating(false);
                setSuccessMessage(null);
            }, 1000);
        },
        onError: (err: Error) => {
            setError((err instanceof Error ? err.message : String(err)) || `Failed to ${isCreating ? 'create' : 'save'} tier`);
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['membership-tiers'] });
        },
    });

    const updateFeatureValueMutation = useMutation({
        mutationFn: async ({ featureId, tierId, value }: { featureId: number; tierId: number; value: string | boolean | number }) => {
            return fetchWithCredentials<{ value: string | boolean | number }>(`/api/tier-features/${featureId}/values/${tierId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ value }),
            });
        },
        onSuccess: (data, variables) => {
            queryClient.setQueryData(['tier-features'], (old: TierFeature[] | undefined) => {
                if (!old) return old;
                return old.map(f => 
                    f.id === variables.featureId 
                        ? { ...f, values: { ...f.values, [variables.tierId]: { tierId: variables.tierId, value: data.value } } }
                        : f
                );
            });
        },
    });

    const updateFeatureLabelMutation = useMutation({
        mutationFn: async ({ featureId, displayLabel }: { featureId: number; displayLabel: string }) => {
            return fetchWithCredentials<{ displayLabel: string }>(`/api/tier-features/${featureId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ displayLabel }),
            });
        },
        onSuccess: (data, variables) => {
            queryClient.setQueryData(['tier-features'], (old: TierFeature[] | undefined) => {
                if (!old) return old;
                return old.map(f => 
                    f.id === variables.featureId ? { ...f, displayLabel: data.displayLabel } : f
                );
            });
        },
    });

    const handleReorderFeature = async (featureId: number, direction: 'up' | 'down') => {
        if (isReordering) return;
        
        const sortedFeatures = [...tierFeatures].sort((a, b) => a.sortOrder - b.sortOrder);
        const currentIndex = sortedFeatures.findIndex(f => f.id === featureId);
        if (currentIndex === -1) return;
        
        const swapIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
        if (swapIndex < 0 || swapIndex >= sortedFeatures.length) return;
        
        const currentFeature = sortedFeatures[currentIndex];
        const swapFeature = sortedFeatures[swapIndex];
        
        const previousData = queryClient.getQueryData(['tier-features']);
        
        queryClient.setQueryData(['tier-features'], (old: TierFeature[] | undefined) => {
            if (!old) return old;
            return old.map(f => {
                if (f.id === currentFeature.id) return { ...f, sortOrder: swapFeature.sortOrder };
                if (f.id === swapFeature.id) return { ...f, sortOrder: currentFeature.sortOrder };
                return f;
            }).sort((a, b) => a.sortOrder - b.sortOrder);
        });
        
        setIsReordering(true);
        try {
            await putWithCredentials(`/api/tier-features/${currentFeature.id}`, { sortOrder: swapFeature.sortOrder });
            await putWithCredentials(`/api/tier-features/${swapFeature.id}`, { sortOrder: currentFeature.sortOrder });
        } catch (error: unknown) {
            queryClient.setQueryData(['tier-features'], previousData);
            console.error('Failed to reorder features:', error);
        } finally {
            setIsReordering(false);
        }
    };

    const createFeatureMutation = useMutation({
        mutationFn: async (featureData: { featureKey: string; displayLabel: string; valueType: string; sortOrder: number }) => {
            return postWithCredentials<TierFeature>('/api/tier-features', featureData);
        },
        onSuccess: () => {
            setNewFeatureForm({ key: '', label: '', type: 'boolean' });
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['tier-features'] });
        },
    });

    const syncStripeMutation = useMutation({
        mutationFn: async () => {
            return postWithCredentials<{ success: boolean; synced: number; failed: number; skipped: number; details?: Array<{ success: boolean; tierName: string; error?: string }> }>('/api/admin/stripe/sync-products', {});
        },
        onSuccess: (data) => {
            let message = `Synced ${data.synced} products to Stripe`;
            if (data.failed > 0) {
                message += `\n\nFailed: ${data.failed}`;
                if (data.details) {
                    const failedDetails = data.details.filter((d: { success: boolean; tierName: string; error?: string }) => !d.success);
                    if (failedDetails.length > 0) {
                        message += '\n' + failedDetails.map((d: { success: boolean; tierName: string; error?: string }) => `- ${d.tierName}: ${d.error}`).join('\n');
                    }
                }
            }
            if (data.skipped > 0) {
                message += `\n\nSkipped: ${data.skipped} (no price configured)`;
            }
            showToast(message, 'success');
            queryClient.invalidateQueries({ queryKey: ['membership-tiers'] });
        },
        onError: (err: Error) => {
            const errorMsg = (err instanceof Error ? err.message : String(err)) || 'Unknown error';
            if (errorMsg.includes('connection not found')) {
                showToast('Stripe sync failed: Stripe is not configured for this environment. Please set up Stripe live keys in Replit\'s Integrations panel before publishing.', 'error');
            } else {
                showToast('Sync failed: ' + errorMsg, 'error');
            }
        },
    });

    const pullFromStripeMutation = useMutation({
        mutationFn: async () => {
            return postWithCredentials<{ success: boolean; tiers: { tiersUpdated: number; errors: string[] }; cafe: { synced: number; created: number; deactivated: number; errors: string[] } }>('/api/admin/stripe/pull-from-stripe', {});
        },
        onSuccess: (data) => {
            let message = `Pulled from Stripe:\n• ${data.tiers.tiersUpdated} tier permissions updated\n• ${data.cafe.synced} cafe items synced`;
            if (data.cafe.created > 0) message += `\n• ${data.cafe.created} new cafe items created`;
            if (data.cafe.deactivated > 0) message += `\n• ${data.cafe.deactivated} cafe items deactivated`;
            const allErrors = [...(data.tiers.errors || []), ...(data.cafe.errors || [])];
            if (allErrors.length > 0) message += `\n\nWarnings:\n${allErrors.join('\n')}`;
            showToast(message, allErrors.length > 0 ? 'warning' : 'success');
            queryClient.invalidateQueries({ queryKey: ['membership-tiers'] });
            queryClient.invalidateQueries({ queryKey: ['cafe'] });
        },
        onError: (err: Error) => {
            showToast('Pull from Stripe failed: ' + ((err instanceof Error ? err.message : String(err)) || 'Unknown error'), 'error');
        },
    });

    const debouncedUpdateFeatureValue = useCallback((featureId: number, tierId: number, value: string | boolean | number) => {
        const key = `${featureId}-${tierId}`;
        if (debounceTimers.current[key]) {
            clearTimeout(debounceTimers.current[key]);
        }
        debounceTimers.current[key] = setTimeout(() => {
            updateFeatureValueMutation.mutate({ featureId, tierId, value });
            delete debounceTimers.current[key];
        }, 500);
    }, [updateFeatureValueMutation]);

    const createFeature = async () => {
        if (!newFeatureForm.key.trim() || !newFeatureForm.label.trim()) return;
        createFeatureMutation.mutate({
            featureKey: newFeatureForm.key.trim(),
            displayLabel: newFeatureForm.label.trim(),
            valueType: newFeatureForm.type,
            sortOrder: tierFeatures.length
        });
    };

    const deleteFeature = (featureId: number) => {
        const featureToDelete = tierFeatures.find(f => f.id === featureId);
        const snapshot = queryClient.getQueryData<TierFeature[]>(['tier-features']);
        queryClient.setQueryData<TierFeature[]>(['tier-features'], (old) =>
            old ? old.filter(f => f.id !== featureId) : old
        );

        undoAction({
            message: `Feature "${featureToDelete?.displayLabel || ''}" deleted`,
            onExecute: async () => {
                await deleteWithCredentials<void>(`/api/tier-features/${featureId}`);
                queryClient.invalidateQueries({ queryKey: ['tier-features'] });
            },
            onUndo: () => {
                if (snapshot !== undefined) queryClient.setQueryData(['tier-features'], snapshot);
            },
            errorMessage: 'Failed to delete feature',
        });
    };

    const openCreate = () => {
        setSelectedTier(getDefaultTier());
        setIsCreating(true);
        setIsEditing(true);
        setError(null);
        setSuccessMessage(null);
    };

    const openEdit = (tier: MembershipTier) => {
        setSelectedTier({
            ...tier,
            highlighted_features: Array.isArray(tier.highlighted_features) ? [...tier.highlighted_features] : [],
            all_features: typeof tier.all_features === 'object' && tier.all_features !== null ? { ...tier.all_features } : {}
        });
        setIsEditing(true);
        setError(null);
        setSuccessMessage(null);
    };

    const handleSave = async () => {
        if (!selectedTier) return;
        setError(null);
        saveTierMutation.mutate({ tier: selectedTier, isNew: isCreating });
    };

    const handleHighlightToggle = (feature: string) => {
        if (!selectedTier) return;
        const current = selectedTier.highlighted_features || [];
        
        if (current.includes(feature)) {
            setSelectedTier({
                ...selectedTier,
                highlighted_features: current.filter(f => f !== feature)
            });
        } else if (current.length < 4) {
            setSelectedTier({
                ...selectedTier,
                highlighted_features: [...current, feature]
            });
        }
    };

    const handleSyncStripe = async () => {
        syncStripeMutation.mutate();
    };

    const handlePullFromStripe = async () => {
        pullFromStripeMutation.mutate();
    };

    return {
        queryClient,
        activeSubTab,
        setActiveSubTab,
        isEditing,
        setIsEditing,
        isCreating,
        setIsCreating,
        selectedTier,
        setSelectedTier,
        error,
        setError,
        successMessage,
        setSuccessMessage,
        editingLabelId,
        setEditingLabelId,
        newFeatureForm,
        setNewFeatureForm,
        isReordering,
        stripeConnection,
        tiers,
        isLoading,
        stripePrices,
        loadingPrices,
        tierFeatures,
        featuresLoading,
        saveTierMutation,
        updateFeatureValueMutation,
        updateFeatureLabelMutation,
        createFeatureMutation,
        syncStripeMutation,
        pullFromStripeMutation,
        debouncedUpdateFeatureValue,
        createFeature,
        deleteFeature,
        openCreate,
        openEdit,
        handleSave,
        handleHighlightToggle,
        handleSyncStripe,
        handlePullFromStripe,
        handleReorderFeature,
    };
}

import React, { useState, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import EmptyState from '../../../components/EmptyState';
import SlideUpDrawer from '../../../components/SlideUpDrawer';
import Toggle from '../../../components/Toggle';
import FloatingActionButton from '../../../components/FloatingActionButton';
import ProductsSubTab from './ProductsSubTab';
import DiscountsSubTab from './DiscountsSubTab';
import { fetchWithCredentials, postWithCredentials, deleteWithCredentials } from '../../../hooks/queries/useFetch';
import { useConfirmDialog } from '../../../components/ConfirmDialog';
import { TiersTabSkeleton } from '../../../components/skeletons';
import { useToast } from '../../../components/Toast';
import CafeTab from './CafeTab';

type SubTab = 'tiers' | 'products' | 'fees' | 'discounts' | 'cafe';

interface TierFeature {
    id: number;
    featureKey: string;
    displayLabel: string;
    valueType: 'boolean' | 'number' | 'text';
    sortOrder: number;
    isActive: boolean;
    values: Record<string, { tierId: number; value: string | boolean | number | null }>;
}

interface MembershipTier {
    id: number;
    name: string;
    slug: string;
    price_string: string;
    description: string | null;
    button_text: string;
    sort_order: number;
    is_active: boolean;
    is_popular: boolean;
    show_in_comparison: boolean;
    show_on_membership_page: boolean;
    highlighted_features: string[];
    all_features: Record<string, boolean>;
    daily_sim_minutes: number;
    guest_passes_per_month: number;
    booking_window_days: number;
    daily_conf_room_minutes: number;
    can_book_simulators: boolean;
    can_book_conference: boolean;
    can_book_wellness: boolean;
    has_group_lessons: boolean;
    has_extended_sessions: boolean;
    has_private_lesson: boolean;
    has_simulator_guest_passes: boolean;
    has_discounted_merch: boolean;
    unlimited_access: boolean;
    stripe_price_id?: string | null;
    stripe_product_id?: string | null;
    price_cents?: number | null;
    product_type?: 'subscription' | 'one_time' | null;
}

interface StripePrice {
    id: string;
    productId: string;
    productName: string;
    nickname: string | null;
    amount: number;
    amountCents: number;
    currency: string;
    interval: string;
    displayString: string;
}

const BOOLEAN_FIELDS = [
    { key: 'can_book_simulators', label: 'Can Book Simulators' },
    { key: 'can_book_conference', label: 'Can Book Conference Room' },
    { key: 'can_book_wellness', label: 'Can Book Wellness' },
    { key: 'has_group_lessons', label: 'Has Group Lessons' },
    { key: 'has_extended_sessions', label: 'Has Extended Sessions' },
    { key: 'has_private_lesson', label: 'Has Private Lesson' },
    { key: 'has_simulator_guest_passes', label: 'Has Simulator Guest Passes' },
    { key: 'has_discounted_merch', label: 'Has Discounted Merch' },
    { key: 'unlimited_access', label: 'Unlimited Access' },
] as const;

const TiersTab: React.FC = () => {
    const queryClient = useQueryClient();
    const { showToast } = useToast();
    const [tiersRef] = useAutoAnimate();
    const [searchParams, setSearchParams] = useSearchParams();
    const subtabParam = searchParams.get('subtab');
    const activeSubTab: SubTab = subtabParam === 'products' ? 'products' : subtabParam === 'fees' ? 'fees' : subtabParam === 'discounts' ? 'discounts' : subtabParam === 'cafe' ? 'cafe' : 'tiers';
    
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
    const { confirm, ConfirmDialogComponent } = useConfirmDialog();

    const SUB_TABS: { key: SubTab; label: string; icon: string }[] = [
        { key: 'tiers', label: 'Memberships', icon: 'layers' },
        { key: 'products', label: 'Products', icon: 'inventory_2' },
        { key: 'fees', label: 'Fees & Passes', icon: 'receipt_long' },
        { key: 'discounts', label: 'Discounts', icon: 'percent' },
        { key: 'cafe', label: 'Cafe Menu', icon: 'local_cafe' },
    ];

    const { data: stripeConnection } = useQuery({
        queryKey: ['stripe-connection-mode'],
        queryFn: async () => {
            const res = await fetch('/api/stripe/debug-connection', { credentials: 'include' });
            if (!res.ok) return null;
            return res.json();
        },
        staleTime: 5 * 60 * 1000,
        retry: 1,
    });

    const { data: tiers = [], isLoading } = useQuery({
        queryKey: ['membership-tiers'],
        queryFn: async () => {
            const data = await fetchWithCredentials<MembershipTier[]>('/api/membership-tiers');
            return data.map((t: any) => ({
                ...t,
                highlighted_features: Array.isArray(t.highlighted_features) ? t.highlighted_features : 
                    (typeof t.highlighted_features === 'string' ? JSON.parse(t.highlighted_features || '[]') : []),
                all_features: typeof t.all_features === 'object' && t.all_features !== null ? t.all_features :
                    (typeof t.all_features === 'string' ? JSON.parse(t.all_features || '{}') : {})
            }));
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
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['membership-tiers'] });
            setSuccessMessage(`Tier ${isCreating ? 'created' : 'updated'} successfully`);
            setTimeout(() => {
                setIsEditing(false);
                setIsCreating(false);
                setSuccessMessage(null);
            }, 1000);
        },
        onError: (err: Error) => {
            setError(err.message || `Failed to ${isCreating ? 'create' : 'save'} tier`);
        },
    });

    const updateFeatureValueMutation = useMutation({
        mutationFn: async ({ featureId, tierId, value }: { featureId: number; tierId: number; value: any }) => {
            return fetchWithCredentials<{ value: any }>(`/api/tier-features/${featureId}/values/${tierId}`, {
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

    const [isReordering, setIsReordering] = useState(false);

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
            await fetchWithCredentials(`/api/tier-features/${currentFeature.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sortOrder: swapFeature.sortOrder }),
            });
            await fetchWithCredentials(`/api/tier-features/${swapFeature.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sortOrder: currentFeature.sortOrder }),
            });
        } catch (error) {
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
            queryClient.invalidateQueries({ queryKey: ['tier-features'] });
            setNewFeatureForm({ key: '', label: '', type: 'boolean' });
        },
    });

    const deleteFeatureMutation = useMutation({
        mutationFn: async (featureId: number) => {
            return deleteWithCredentials<void>(`/api/tier-features/${featureId}`);
        },
        onSuccess: (_, featureId) => {
            queryClient.setQueryData(['tier-features'], (old: TierFeature[] | undefined) => {
                if (!old) return old;
                return old.filter(f => f.id !== featureId);
            });
        },
    });

    const syncStripeMutation = useMutation({
        mutationFn: async () => {
            return postWithCredentials<{ success: boolean; synced: number; failed: number; skipped: number; details?: any[] }>('/api/admin/stripe/sync-products', {});
        },
        onSuccess: (data) => {
            let message = `Synced ${data.synced} products to Stripe`;
            if (data.failed > 0) {
                message += `\n\nFailed: ${data.failed}`;
                if (data.details) {
                    const failedDetails = data.details.filter((d: any) => !d.success);
                    if (failedDetails.length > 0) {
                        message += '\n' + failedDetails.map((d: any) => `- ${d.tierName}: ${d.error}`).join('\n');
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
            const errorMsg = err.message || 'Unknown error';
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
            queryClient.invalidateQueries({ queryKey: ['cafe-menu'] });
        },
        onError: (err: Error) => {
            showToast('Pull from Stripe failed: ' + (err.message || 'Unknown error'), 'error');
        },
    });

    const debouncedUpdateFeatureValue = useCallback((featureId: number, tierId: number, value: any) => {
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

    const deleteFeature = async (featureId: number) => {
        const confirmed = await confirm({
            title: 'Delete Feature',
            message: 'Are you sure you want to delete this feature? This will remove it from all tiers.',
            confirmText: 'Delete',
            variant: 'danger'
        });
        if (!confirmed) return;
        deleteFeatureMutation.mutate(featureId);
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

    if (isLoading) {
        return <TiersTabSkeleton />;
    }

    return (
        <div className="animate-pop-in">
            {/* Sub-tabs navigation */}
            <div className="flex gap-1 p-1 bg-gray-100 dark:bg-black/30 rounded-xl mb-6 overflow-x-auto scrollbar-hide">
                {SUB_TABS.map(tab => (
                    <button
                        key={tab.key}
                        onClick={() => setActiveSubTab(tab.key)}
                        className={`flex items-center gap-1 px-2 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium whitespace-nowrap transition-all duration-fast flex-shrink-0 ${
                            activeSubTab === tab.key
                                ? 'bg-white dark:bg-white/10 text-primary dark:text-white shadow-sm'
                                : 'text-gray-600 dark:text-gray-400 hover:text-primary dark:hover:text-white'
                        }`}
                    >
                        <span aria-hidden="true" className="material-symbols-outlined text-base sm:text-lg">{tab.icon}</span>
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* Products/Fees/Discounts sub-tabs */}
            <div key={activeSubTab} className="animate-content-enter">
            {activeSubTab === 'products' && <ProductsSubTab activeSubTab="membership" />}
            {activeSubTab === 'fees' && (() => {
                const oneTimePasses = tiers.filter(t => t.product_type === 'one_time');
                return (
                    <div className="space-y-6">
                        {oneTimePasses.length > 0 && (
                            <div>
                                <div className="flex justify-between items-center mb-4">
                                    <h3 className="text-sm font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                                        Day Passes & Guest Passes
                                    </h3>
                                    <span className="text-xs text-gray-400 dark:text-gray-500">
                                        {oneTimePasses.length} item{oneTimePasses.length !== 1 ? 's' : ''}
                                    </span>
                                </div>
                                <div className="space-y-3">
                                    {oneTimePasses.map((pass, index) => (
                                        <div 
                                            key={pass.id} 
                                            onClick={() => openEdit(pass)}
                                            className="bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border border-gray-200 dark:border-white/20 cursor-pointer hover:border-primary/30 transition-all duration-fast animate-slide-up-stagger"
                                            style={{ '--stagger-index': index } as React.CSSProperties}
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
                                                <button className="text-gray-600 hover:text-primary dark:hover:text-white transition-colors">
                                                    <span aria-hidden="true" className="material-symbols-outlined">edit</span>
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                        <div>
                            <h3 className="text-sm font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-4">
                                HubSpot Fee Products
                            </h3>
                            <ProductsSubTab activeSubTab="fees" />
                        </div>
                    </div>
                );
            })()}
            {activeSubTab === 'discounts' && <DiscountsSubTab />}
            {activeSubTab === 'cafe' && <CafeTab />}


            <SlideUpDrawer 
                isOpen={isEditing && !!selectedTier} 
                onClose={() => { setIsEditing(false); setIsCreating(false); }} 
                title={isCreating ? 'New Tier' : `Edit: ${selectedTier?.name || ''}`}
                maxHeight="full"
                stickyFooter={
                    <div className="flex gap-3 justify-end p-4">
                        <button 
                            onClick={() => { setIsEditing(false); setIsCreating(false); }} 
                            className="px-5 py-2.5 text-gray-500 dark:text-white/80 font-bold hover:bg-gray-100 dark:hover:bg-white/10 rounded-xl transition-colors"
                        >
                            Cancel
                        </button>
                        <button 
                            onClick={handleSave} 
                            disabled={saveTierMutation.isPending}
                            className="px-6 py-2.5 bg-primary text-white rounded-xl font-bold shadow-md hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2"
                        >
                            {saveTierMutation.isPending && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>}
                            {saveTierMutation.isPending ? 'Saving...' : 'Save Changes'}
                        </button>
                    </div>
                }
            >
                <div className="p-5 space-y-6">
                    {error && (
                        <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-lg text-sm">
                            {error}
                        </div>
                    )}

                    {successMessage && (
                        <div className="p-3 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 rounded-lg text-sm">
                            {successMessage}
                        </div>
                    )}

                    {(() => {
                        const isMembershipTier = selectedTier?.product_type !== 'one_time';
                        return (
                    <div>
                        <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">{isMembershipTier ? 'MEMBERSHIP PAGE CARD' : 'PRODUCT DETAILS'}</h4>
                        <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-4">{isMembershipTier ? 'Controls what appears on the membership page pricing cards.' : 'Basic product information.'}</p>
                        <div className="space-y-3">
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Name</label>
                                    <input 
                                        className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast" 
                                        value={selectedTier?.name || ''} 
                                        onChange={e => selectedTier && setSelectedTier({...selectedTier, name: e.target.value})} 
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Price String</label>
                                    <input 
                                        className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast" 
                                        value={selectedTier?.price_string || ''} 
                                        onChange={e => selectedTier && setSelectedTier({...selectedTier, price_string: e.target.value})} 
                                        placeholder="e.g., $199/mo"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Description</label>
                                <textarea 
                                    className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast resize-none" 
                                    rows={2}
                                    value={selectedTier?.description || ''} 
                                    onChange={e => selectedTier && setSelectedTier({...selectedTier, description: e.target.value})} 
                                />
                            </div>
                            <label className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/25 cursor-pointer hover:bg-gray-100 dark:hover:bg-black/30 transition-colors">
                                <span className="text-sm text-primary dark:text-white">Active</span>
                                <Toggle
                                    checked={selectedTier?.is_active || false}
                                    onChange={(val) => selectedTier && setSelectedTier({...selectedTier, is_active: val})}
                                    label="Active"
                                />
                            </label>
                            {isMembershipTier && (
                                <>
                                    <label className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/25 cursor-pointer hover:bg-gray-100 dark:hover:bg-black/30 transition-colors">
                                        <span className="text-sm text-primary dark:text-white">Show on Membership Page</span>
                                        <Toggle
                                            checked={selectedTier?.show_on_membership_page ?? true}
                                            onChange={(val) => selectedTier && setSelectedTier({...selectedTier, show_on_membership_page: val})}
                                            label="Show on Membership Page"
                                        />
                                    </label>
                                    <div>
                                        <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Button Text</label>
                                        <input 
                                            className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast" 
                                            value={selectedTier?.button_text || ''} 
                                            onChange={e => selectedTier && setSelectedTier({...selectedTier, button_text: e.target.value})} 
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Sort Order</label>
                                        <input 
                                            type="number"
                                            className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast" 
                                            value={selectedTier?.sort_order ?? 0} 
                                            onChange={e => selectedTier && setSelectedTier({...selectedTier, sort_order: parseInt(e.target.value) || 0})} 
                                        />
                                    </div>
                                    <label className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/25 cursor-pointer hover:bg-gray-100 dark:hover:bg-black/30 transition-colors">
                                        <span className="text-sm text-primary dark:text-white">Mark as Popular</span>
                                        <Toggle
                                            checked={selectedTier?.is_popular || false}
                                            onChange={(val) => selectedTier && setSelectedTier({...selectedTier, is_popular: val})}
                                            label="Mark as Popular"
                                        />
                                    </label>
                                    <div className="mt-2">
                                        <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">
                                            Card Features
                                            {selectedTier?.stripe_product_id ? (
                                                <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 text-[10px] normal-case font-semibold">
                                                    <span aria-hidden="true" className="material-symbols-outlined text-xs">cloud</span>
                                                    Managed by Stripe
                                                </span>
                                            ) : (
                                                <span className="ml-2 font-normal text-gray-400">({(selectedTier?.highlighted_features || []).length}/4)</span>
                                            )}
                                        </h4>
                                        {selectedTier?.stripe_product_id ? (
                                            <div>
                                                <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-3">Edit these in Stripe Dashboard → Products → Marketing Features</p>
                                                {(selectedTier?.highlighted_features || []).length > 0 ? (
                                                    <div className="space-y-2">
                                                        {(selectedTier?.highlighted_features || []).map((feature, idx) => (
                                                            <div key={idx} className="flex items-center gap-2 p-2.5 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/25">
                                                                <span aria-hidden="true" className="material-symbols-outlined text-sm text-green-600 dark:text-green-400">check_circle</span>
                                                                <span className="text-sm text-primary dark:text-white">{feature}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                ) : (
                                                    <p className="text-xs text-gray-400 dark:text-gray-500 italic">No marketing features configured in Stripe</p>
                                                )}
                                            </div>
                                        ) : (
                                            <div>
                                                <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                                                    Select up to 4 features to highlight on the pricing card
                                                </p>
                                                <div className="space-y-2">
                                                    {BOOLEAN_FIELDS.filter(f => (selectedTier as any)?.[f.key]).map(field => (
                                                        <label 
                                                            key={field.key}
                                                            className={`flex items-center gap-3 p-2.5 rounded-xl cursor-pointer transition-colors ${
                                                                (selectedTier?.highlighted_features || []).includes(field.label)
                                                                    ? 'bg-primary/10 dark:bg-primary/20 border border-primary/30'
                                                                    : 'bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/25 hover:bg-gray-100 dark:hover:bg-black/30'
                                                            }`}
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                checked={(selectedTier?.highlighted_features || []).includes(field.label)}
                                                                onChange={() => handleHighlightToggle(field.label)}
                                                                disabled={(selectedTier?.highlighted_features || []).length >= 4 && !(selectedTier?.highlighted_features || []).includes(field.label)}
                                                                className="w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary"
                                                            />
                                                            <span className="text-sm text-primary dark:text-white">{field.label}</span>
                                                        </label>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                        );
                    })()} 

                    <div className="border-t-2 border-gray-200 dark:border-white/15 pt-6">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">STRIPE-MANAGED SETTINGS</h4>
                        <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-4">These values sync from Stripe. When linked to a Stripe product, edit them in the Stripe Dashboard.</p>
                        <div className="space-y-6">
                            <div>
                                <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">Stripe Pricing</h5>
                                <div className="space-y-3">
                                    {selectedTier?.stripe_price_id ? (
                                        <div className="p-3 rounded-xl bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-500/30">
                                            <div className="flex items-center gap-2 mb-2">
                                                <span aria-hidden="true" className="material-symbols-outlined text-indigo-600 dark:text-indigo-400">link</span>
                                                <span className="text-sm font-medium text-indigo-700 dark:text-indigo-300">Linked to Stripe</span>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        if (!selectedTier) return;
                                                        setSelectedTier({
                                                            ...selectedTier,
                                                            stripe_price_id: null,
                                                            stripe_product_id: null,
                                                            price_cents: null
                                                        });
                                                        setSuccessMessage('Stripe link removed. Save to confirm.');
                                                        setTimeout(() => setSuccessMessage(null), 3000);
                                                    }}
                                                    className="ml-auto px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                                                >
                                                    Unlink
                                                </button>
                                            </div>
                                            <div className="grid grid-cols-2 gap-2 text-xs">
                                                <div>
                                                    <span className="text-indigo-500 dark:text-indigo-400">Product:</span>
                                                    <span className="ml-1 text-indigo-700 dark:text-indigo-300 font-mono">{selectedTier.stripe_product_id || '—'}</span>
                                                </div>
                                                <div>
                                                    <span className="text-indigo-500 dark:text-indigo-400">Price:</span>
                                                    <span className="ml-1 text-indigo-700 dark:text-indigo-300 font-mono">{selectedTier.stripe_price_id}</span>
                                                </div>
                                            </div>
                                        </div>
                                    ) : (
                                        <div>
                                            <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Link to Stripe Price</label>
                                            <select
                                                className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast"
                                                value=""
                                                onChange={e => {
                                                    if (!selectedTier) return;
                                                    const priceId = e.target.value;
                                                    if (priceId) {
                                                        const selectedPrice = stripePrices.find(p => p.id === priceId);
                                                        if (selectedPrice) {
                                                            setSelectedTier({
                                                                ...selectedTier,
                                                                stripe_price_id: selectedPrice.id,
                                                                stripe_product_id: selectedPrice.productId,
                                                                price_cents: selectedPrice.amountCents
                                                            });
                                                        }
                                                    }
                                                }}
                                            >
                                                <option value="">Not linked to Stripe</option>
                                                {loadingPrices ? (
                                                    <option disabled>Loading prices...</option>
                                                ) : (
                                                    stripePrices.map(price => (
                                                        <option key={price.id} value={price.id}>
                                                            {price.displayString}
                                                        </option>
                                                    ))
                                                )}
                                            </select>
                                        </div>
                                    )}
                                    <div>
                                        <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">
                                            Price (Cents)
                                            {selectedTier?.stripe_price_id && (
                                                <span className="ml-2 text-indigo-600 dark:text-indigo-400 normal-case font-normal">Auto-filled from Stripe</span>
                                            )}
                                        </label>
                                        <input
                                            type="number"
                                            className={`w-full border border-gray-200 dark:border-white/20 p-2.5 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast ${
                                                selectedTier?.stripe_price_id 
                                                    ? 'bg-gray-100 dark:bg-black/50 cursor-not-allowed' 
                                                    : 'bg-gray-50 dark:bg-black/30'
                                            }`}
                                            value={selectedTier?.price_cents || ''}
                                            onChange={e => selectedTier && setSelectedTier({...selectedTier, price_cents: parseInt(e.target.value) || null})}
                                            readOnly={!!selectedTier?.stripe_price_id}
                                            placeholder="e.g., 19900 for $199.00"
                                        />
                                    </div>
                                </div>
                            </div>

                            {(() => {
                                const isMembershipTier = selectedTier?.product_type !== 'one_time';
                                return isMembershipTier && (
                                    <>
                                        <div>
                                            <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">
                                                Booking Limits
                                                {selectedTier?.stripe_product_id && (
                                                    <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 text-[10px] normal-case font-semibold">
                                                        <span aria-hidden="true" className="material-symbols-outlined text-xs">cloud</span>
                                                        Managed by Stripe
                                                    </span>
                                                )}
                                            </h5>
                                            <div className="grid grid-cols-2 gap-3">
                                                <div>
                                                    <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Daily Sim Minutes</label>
                                                    <input 
                                                        type="number"
                                                        className={`w-full border border-gray-200 dark:border-white/20 p-2.5 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast ${
                                                            selectedTier?.stripe_product_id 
                                                                ? 'bg-gray-100 dark:bg-black/50 cursor-not-allowed' 
                                                                : 'bg-gray-50 dark:bg-black/30'
                                                        }`}
                                                        value={selectedTier?.daily_sim_minutes || 0} 
                                                        onChange={e => selectedTier && setSelectedTier({...selectedTier, daily_sim_minutes: parseInt(e.target.value) || 0})} 
                                                        readOnly={!!selectedTier?.stripe_product_id}
                                                    />
                                                </div>
                                                <div>
                                                    <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Guest Passes/Month</label>
                                                    <input 
                                                        type="number"
                                                        className={`w-full border border-gray-200 dark:border-white/20 p-2.5 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast ${
                                                            selectedTier?.stripe_product_id 
                                                                ? 'bg-gray-100 dark:bg-black/50 cursor-not-allowed' 
                                                                : 'bg-gray-50 dark:bg-black/30'
                                                        }`}
                                                        value={selectedTier?.guest_passes_per_month || 0} 
                                                        onChange={e => selectedTier && setSelectedTier({...selectedTier, guest_passes_per_month: parseInt(e.target.value) || 0})} 
                                                        readOnly={!!selectedTier?.stripe_product_id}
                                                    />
                                                </div>
                                                <div>
                                                    <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Booking Window (Days)</label>
                                                    <input 
                                                        type="number"
                                                        className={`w-full border border-gray-200 dark:border-white/20 p-2.5 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast ${
                                                            selectedTier?.stripe_product_id 
                                                                ? 'bg-gray-100 dark:bg-black/50 cursor-not-allowed' 
                                                                : 'bg-gray-50 dark:bg-black/30'
                                                        }`}
                                                        value={selectedTier?.booking_window_days || 7} 
                                                        onChange={e => selectedTier && setSelectedTier({...selectedTier, booking_window_days: parseInt(e.target.value) || 7})} 
                                                        readOnly={!!selectedTier?.stripe_product_id}
                                                    />
                                                </div>
                                                <div>
                                                    <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Daily Conf Room Minutes</label>
                                                    <input 
                                                        type="number"
                                                        className={`w-full border border-gray-200 dark:border-white/20 p-2.5 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast ${
                                                            selectedTier?.stripe_product_id 
                                                                ? 'bg-gray-100 dark:bg-black/50 cursor-not-allowed' 
                                                                : 'bg-gray-50 dark:bg-black/30'
                                                        }`}
                                                        value={selectedTier?.daily_conf_room_minutes || 0} 
                                                        onChange={e => selectedTier && setSelectedTier({...selectedTier, daily_conf_room_minutes: parseInt(e.target.value) || 0})} 
                                                        readOnly={!!selectedTier?.stripe_product_id}
                                                    />
                                                </div>
                                            </div>
                                        </div>

                                        <div>
                                            <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">
                                                Access Permissions
                                                {selectedTier?.stripe_product_id && (
                                                    <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 text-[10px] normal-case font-semibold">
                                                        <span aria-hidden="true" className="material-symbols-outlined text-xs">cloud</span>
                                                        Managed by Stripe
                                                    </span>
                                                )}
                                            </h5>
                                            <div className="space-y-2">
                                                {BOOLEAN_FIELDS.map(field => (
                                                    <label 
                                                        key={field.key}
                                                        className={`flex items-center justify-between p-3 rounded-xl border transition-colors ${
                                                            selectedTier?.stripe_product_id
                                                                ? 'bg-gray-100 dark:bg-black/40 border-gray-200 dark:border-white/15 cursor-not-allowed opacity-75'
                                                                : 'bg-gray-50 dark:bg-black/20 border-gray-200 dark:border-white/25 cursor-pointer hover:bg-gray-100 dark:hover:bg-black/30'
                                                        }`}
                                                    >
                                                        <span className="text-sm text-primary dark:text-white">{field.label}</span>
                                                        <Toggle
                                                            checked={(selectedTier as any)?.[field.key] || false}
                                                            onChange={(val) => {
                                                                if (selectedTier?.stripe_product_id) return;
                                                                selectedTier && setSelectedTier({...selectedTier, [field.key]: val});
                                                            }}
                                                            label={field.label}
                                                        />
                                                    </label>
                                                ))}
                                            </div>
                                        </div>
                                    </>
                                );
                            })()} 
                        </div>
                    </div>

                    {(() => {
                        const isMembershipTier = selectedTier?.product_type !== 'one_time';
                        return isMembershipTier && (
                    <div className="border-t-2 border-gray-200 dark:border-white/15 pt-6">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">COMPARE TABLE</h4>
                        <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-4">Controls what appears in the feature comparison table on the compare page.</p>
                        <div className="space-y-6">
                            <label className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/25 cursor-pointer hover:bg-gray-100 dark:hover:bg-black/30 transition-colors">
                                <span className="text-sm text-primary dark:text-white">Show in Compare Table</span>
                                <Toggle
                                    checked={selectedTier?.show_in_comparison || false}
                                    onChange={(val) => selectedTier && setSelectedTier({...selectedTier, show_in_comparison: val})}
                                    label="Show in Compare Table"
                                />
                            </label>

                            <div>
                                <div className="flex items-center justify-between mb-3">
                                    <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                                        Feature Values
                                        {featuresLoading && (
                                            <span className="ml-2 text-gray-400">Loading...</span>
                                        )}
                                    </h5>
                                </div>
                                
                                {tierFeatures.length > 0 && selectedTier && (
                                    <div className="space-y-3">
                                        {tierFeatures.map((feature, index) => (
                                            <div key={feature.id} className="p-3 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/25">
                                                <div className="flex items-center justify-between mb-2">
                                                    <div className="flex items-center gap-2">
                                                        <div className="flex flex-col">
                                                            <button
                                                                onClick={() => handleReorderFeature(feature.id, 'up')}
                                                                disabled={index === 0 || isReordering}
                                                                className="text-gray-400 hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors p-0.5"
                                                                aria-label="Move feature up"
                                                            >
                                                                <span aria-hidden="true" className="material-symbols-outlined text-base leading-none">keyboard_arrow_up</span>
                                                            </button>
                                                            <button
                                                                onClick={() => handleReorderFeature(feature.id, 'down')}
                                                                disabled={index === tierFeatures.length - 1 || isReordering}
                                                                className="text-gray-400 hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors p-0.5"
                                                                aria-label="Move feature down"
                                                            >
                                                                <span aria-hidden="true" className="material-symbols-outlined text-base leading-none">keyboard_arrow_down</span>
                                                            </button>
                                                        </div>
                                                        {editingLabelId === feature.id ? (
                                                            <input
                                                                className="flex-1 mr-2 text-sm font-medium border-b border-primary bg-transparent text-primary dark:text-white outline-none"
                                                                value={feature.displayLabel}
                                                                onChange={e => {
                                                                    const newLabel = e.target.value;
                                                                    queryClient.setQueryData(['tier-features'], (old: TierFeature[] | undefined) => {
                                                                        if (!old) return old;
                                                                        return old.map(f => f.id === feature.id ? { ...f, displayLabel: newLabel } : f);
                                                                    });
                                                                }}
                                                                onBlur={() => {
                                                                    updateFeatureLabelMutation.mutate({ featureId: feature.id, displayLabel: feature.displayLabel });
                                                                    setEditingLabelId(null);
                                                                }}
                                                                onKeyDown={e => {
                                                                    if (e.key === 'Enter') {
                                                                        updateFeatureLabelMutation.mutate({ featureId: feature.id, displayLabel: feature.displayLabel });
                                                                        setEditingLabelId(null);
                                                                    }
                                                                }}
                                                                autoFocus
                                                            />
                                                        ) : (
                                                            <span 
                                                                className="text-sm font-medium text-primary dark:text-white cursor-pointer hover:text-primary/70"
                                                                onClick={() => setEditingLabelId(feature.id)}
                                                            >
                                                                {feature.displayLabel}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-[10px] text-gray-400 uppercase">{feature.valueType}</span>
                                                        <button
                                                            onClick={() => deleteFeature(feature.id)}
                                                            className="text-gray-400 hover:text-red-500 transition-colors"
                                                        >
                                                            <span aria-hidden="true" className="material-symbols-outlined text-sm">delete</span>
                                                        </button>
                                                    </div>
                                                </div>
                                                
                                                {feature.valueType === 'boolean' ? (
                                                    <Toggle
                                                        checked={feature.values[selectedTier.id]?.value === true}
                                                        onChange={(val) => debouncedUpdateFeatureValue(feature.id, selectedTier.id, val)}
                                                        label={feature.displayLabel}
                                                    />
                                                ) : feature.valueType === 'number' ? (
                                                    <input
                                                        type="number"
                                                        className="w-full border border-gray-200 dark:border-white/20 bg-white dark:bg-black/30 p-2 rounded-lg text-sm text-primary dark:text-white"
                                                        value={feature.values[selectedTier.id]?.value as number || ''}
                                                        onChange={e => {
                                                            const newVal = parseInt(e.target.value) || 0;
                                                            queryClient.setQueryData(['tier-features'], (old: TierFeature[] | undefined) => {
                                                                if (!old) return old;
                                                                return old.map(f => 
                                                                    f.id === feature.id 
                                                                        ? { ...f, values: { ...f.values, [selectedTier.id]: { tierId: selectedTier.id, value: newVal } } }
                                                                        : f
                                                                );
                                                            });
                                                            debouncedUpdateFeatureValue(feature.id, selectedTier.id, newVal);
                                                        }}
                                                    />
                                                ) : (
                                                    <input
                                                        type="text"
                                                        className="w-full border border-gray-200 dark:border-white/20 bg-white dark:bg-black/30 p-2 rounded-lg text-sm text-primary dark:text-white"
                                                        value={feature.values[selectedTier.id]?.value as string || ''}
                                                        onChange={e => {
                                                            const newVal = e.target.value;
                                                            queryClient.setQueryData(['tier-features'], (old: TierFeature[] | undefined) => {
                                                                if (!old) return old;
                                                                return old.map(f => 
                                                                    f.id === feature.id 
                                                                        ? { ...f, values: { ...f.values, [selectedTier.id]: { tierId: selectedTier.id, value: newVal } } }
                                                                        : f
                                                                );
                                                            });
                                                            debouncedUpdateFeatureValue(feature.id, selectedTier.id, newVal);
                                                        }}
                                                    />
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}

                                <div className="mt-4 p-3 rounded-xl border-2 border-dashed border-gray-200 dark:border-white/20">
                                    <h5 className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-2">Add New Feature</h5>
                                    <div className="grid grid-cols-3 gap-2 mb-2">
                                        <input
                                            className="border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2 rounded-lg text-sm text-primary dark:text-white placeholder:text-gray-400"
                                            placeholder="Key"
                                            value={newFeatureForm.key}
                                            onChange={e => setNewFeatureForm(prev => ({ ...prev, key: e.target.value }))}
                                        />
                                        <input
                                            className="border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2 rounded-lg text-sm text-primary dark:text-white placeholder:text-gray-400"
                                            placeholder="Label"
                                            value={newFeatureForm.label}
                                            onChange={e => setNewFeatureForm(prev => ({ ...prev, label: e.target.value }))}
                                        />
                                        <select
                                            className="border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2 rounded-lg text-sm text-primary dark:text-white"
                                            value={newFeatureForm.type}
                                            onChange={e => setNewFeatureForm(prev => ({ ...prev, type: e.target.value as any }))}
                                        >
                                            <option value="boolean">Boolean</option>
                                            <option value="number">Number</option>
                                            <option value="text">Text</option>
                                        </select>
                                    </div>
                                    <button
                                        onClick={createFeature}
                                        disabled={!newFeatureForm.key.trim() || !newFeatureForm.label.trim() || createFeatureMutation.isPending}
                                        className="w-full py-2 text-sm font-medium text-primary dark:text-white bg-gray-100 dark:bg-white/10 rounded-lg hover:bg-gray-200 dark:hover:bg-white/20 transition-colors disabled:opacity-50"
                                    >
                                        {createFeatureMutation.isPending ? 'Adding...' : 'Add Feature'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                        );
                    })()} 
                </div>
            </SlideUpDrawer>

            {activeSubTab === 'tiers' && (() => {
                const subscriptionTiers = tiers.filter(t => t.product_type !== 'one_time');
                return (
                <>
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="text-sm font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                            Membership Tiers
                        </h3>
                        <div className="flex items-center gap-2">
                            {stripeConnection?.mode && (
                                <span className={`flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full ${
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
                                disabled={pullFromStripeMutation.isPending}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/20 rounded-lg hover:bg-purple-100 dark:hover:bg-purple-900/30 transition-colors disabled:opacity-50"
                            >
                                <span aria-hidden="true" className={`material-symbols-outlined text-sm ${pullFromStripeMutation.isPending ? 'animate-spin' : ''}`}>
                                    {pullFromStripeMutation.isPending ? 'progress_activity' : 'cloud_download'}
                                </span>
                                {pullFromStripeMutation.isPending ? 'Pulling...' : 'Pull from Stripe'}
                            </button>
                            <button
                                onClick={handleSyncStripe}
                                disabled={syncStripeMutation.isPending}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/20 rounded-lg hover:bg-indigo-100 dark:hover:bg-indigo-900/30 transition-colors disabled:opacity-50"
                            >
                                <span aria-hidden="true" className={`material-symbols-outlined text-sm ${syncStripeMutation.isPending ? 'animate-spin' : ''}`}>
                                    {syncStripeMutation.isPending ? 'progress_activity' : 'sync'}
                                </span>
                                {syncStripeMutation.isPending ? 'Syncing...' : 'Sync to Stripe'}
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
                        <div ref={tiersRef} className="space-y-3 animate-slide-up-stagger" style={{ '--stagger-index': 0 } as React.CSSProperties}>
                            {subscriptionTiers.map((tier, index) => (
                                <div 
                                    key={tier.id} 
                                    onClick={() => openEdit(tier)}
                                    className="bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border border-gray-200 dark:border-white/20 cursor-pointer hover:border-primary/30 transition-colors tactile-card animate-slide-up-stagger"
                                    style={{ '--stagger-index': index + 1 } as React.CSSProperties}
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
                                        <button className="text-gray-600 hover:text-primary dark:hover:text-white transition-colors">
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
                </>
                );
            })()}
            </div>

            {activeSubTab === 'tiers' && (
                <FloatingActionButton onClick={openCreate} color="brand" icon="add" label="Add new tier" />
            )}
            {activeSubTab === 'discounts' && (
                <FloatingActionButton 
                    onClick={() => {
                        const createBtn = document.querySelector('[data-create-coupon-btn]') as HTMLButtonElement;
                        if (createBtn) createBtn.click();
                    }} 
                    color="brand" 
                    icon="add" 
                    label="Create new coupon" 
                />
            )}
            <ConfirmDialogComponent />
        </div>
    );
};

export default TiersTab;

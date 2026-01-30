import React, { useState, useEffect, useRef, useCallback } from 'react';
import ModalShell from '../../../components/ModalShell';
import Toggle from '../../../components/Toggle';
import FloatingActionButton from '../../../components/FloatingActionButton';
import ProductsSubTab from './ProductsSubTab';
import DiscountsSubTab from './DiscountsSubTab';
import { apiRequest } from '../../../lib/apiRequest';

type SubTab = 'tiers' | 'products' | 'fees' | 'discounts';

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
    const [activeSubTab, setActiveSubTab] = useState<SubTab>('tiers');
    const [tiers, setTiers] = useState<MembershipTier[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isEditing, setIsEditing] = useState(false);
    const [isCreating, setIsCreating] = useState(false);
    const [selectedTier, setSelectedTier] = useState<MembershipTier | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [syncing, setSyncing] = useState(false);
    const [stripePrices, setStripePrices] = useState<StripePrice[]>([]);
    const [loadingPrices, setLoadingPrices] = useState(false);
    const [tierFeatures, setTierFeatures] = useState<TierFeature[]>([]);
    const [featuresLoading, setFeaturesLoading] = useState(false);
    const [editingLabelId, setEditingLabelId] = useState<number | null>(null);
    const [newFeatureForm, setNewFeatureForm] = useState({ key: '', label: '', type: 'boolean' as 'boolean' | 'number' | 'text' });
    const debounceTimers = useRef<Record<string, NodeJS.Timeout>>({});

    const SUB_TABS: { key: SubTab; label: string; icon: string }[] = [
        { key: 'tiers', label: 'Memberships', icon: 'layers' },
        { key: 'products', label: 'Products', icon: 'inventory_2' },
        { key: 'fees', label: 'Fees & Passes', icon: 'receipt_long' },
        { key: 'discounts', label: 'Discounts', icon: 'percent' },
    ];

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

    const fetchStripePrices = async () => {
        setLoadingPrices(true);
        try {
            const res = await fetch('/api/stripe/prices/recurring', { credentials: 'include' });
            console.log('[TiersTab] Stripe prices response status:', res.status);
            if (res.ok) {
                const data = await res.json();
                console.log('[TiersTab] Stripe prices received:', data.prices?.length || 0, 'prices');
                setStripePrices(data.prices || []);
            } else {
                console.error('[TiersTab] Stripe prices fetch failed:', res.status);
            }
        } catch (err) {
            console.error('Failed to fetch Stripe prices:', err);
        } finally {
            setLoadingPrices(false);
        }
    };

    const fetchTierFeatures = async () => {
        setFeaturesLoading(true);
        try {
            const res = await fetch('/api/tier-features', { credentials: 'include' });
            if (res.ok) {
                const data = await res.json();
                setTierFeatures(data.features || []);
            }
        } catch (err) {
            console.error('Failed to fetch tier features:', err);
        } finally {
            setFeaturesLoading(false);
        }
    };

    const updateFeatureValue = useCallback(async (featureId: number, tierId: number, value: any) => {
        try {
            const res = await fetch(`/api/tier-features/${featureId}/values/${tierId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ value })
            });
            if (res.ok) {
                const data = await res.json();
                setTierFeatures(prev => prev.map(f => 
                    f.id === featureId 
                        ? { ...f, values: { ...f.values, [tierId]: { tierId, value: data.value } } }
                        : f
                ));
            }
        } catch (err) {
            console.error('Failed to update feature value:', err);
        }
    }, []);

    const debouncedUpdateFeatureValue = useCallback((featureId: number, tierId: number, value: any) => {
        const key = `${featureId}-${tierId}`;
        if (debounceTimers.current[key]) {
            clearTimeout(debounceTimers.current[key]);
        }
        debounceTimers.current[key] = setTimeout(() => {
            updateFeatureValue(featureId, tierId, value);
            delete debounceTimers.current[key];
        }, 500);
    }, [updateFeatureValue]);

    const updateFeatureLabel = async (featureId: number, displayLabel: string) => {
        try {
            const res = await fetch(`/api/tier-features/${featureId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ displayLabel })
            });
            if (res.ok) {
                const data = await res.json();
                setTierFeatures(prev => prev.map(f => 
                    f.id === featureId ? { ...f, displayLabel: data.displayLabel } : f
                ));
            }
        } catch (err) {
            console.error('Failed to update feature label:', err);
        }
    };

    const createFeature = async () => {
        if (!newFeatureForm.key.trim() || !newFeatureForm.label.trim()) return;
        try {
            const res = await fetch('/api/tier-features', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    featureKey: newFeatureForm.key.trim(),
                    displayLabel: newFeatureForm.label.trim(),
                    valueType: newFeatureForm.type,
                    sortOrder: tierFeatures.length
                })
            });
            if (res.ok) {
                await fetchTierFeatures();
                setNewFeatureForm({ key: '', label: '', type: 'boolean' });
            }
        } catch (err) {
            console.error('Failed to create feature:', err);
        }
    };

    const deleteFeature = async (featureId: number) => {
        if (!confirm('Are you sure you want to delete this feature? This will remove it from all tiers.')) return;
        try {
            const res = await fetch(`/api/tier-features/${featureId}`, {
                method: 'DELETE',
                credentials: 'include'
            });
            if (res.ok) {
                setTierFeatures(prev => prev.filter(f => f.id !== featureId));
            }
        } catch (err) {
            console.error('Failed to delete feature:', err);
        }
    };

    const openCreate = () => {
        setSelectedTier(getDefaultTier());
        setIsCreating(true);
        setIsEditing(true);
        setError(null);
        setSuccessMessage(null);
    };

    const fetchTiers = async () => {
        try {
            const res = await fetch('/api/membership-tiers', { credentials: 'include' });
            const data = await res.json();
            setTiers(data.map((t: any) => ({
                ...t,
                highlighted_features: Array.isArray(t.highlighted_features) ? t.highlighted_features : 
                    (typeof t.highlighted_features === 'string' ? JSON.parse(t.highlighted_features || '[]') : []),
                all_features: typeof t.all_features === 'object' && t.all_features !== null ? t.all_features :
                    (typeof t.all_features === 'string' ? JSON.parse(t.all_features || '{}') : {})
            })));
        } catch (err) {
            console.error('Failed to fetch tiers:', err);
            setError('Failed to load tiers');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchTiers();
        fetchStripePrices();
    }, []);

    useEffect(() => {
        if (isEditing) {
            document.body.style.overflow = 'hidden';
            document.body.style.position = 'fixed';
            document.body.style.width = '100%';
            document.body.style.top = `-${window.scrollY}px`;
        } else {
            const scrollY = document.body.style.top;
            document.body.style.overflow = '';
            document.body.style.position = '';
            document.body.style.width = '';
            document.body.style.top = '';
            window.scrollTo(0, parseInt(scrollY || '0') * -1);
        }
        return () => {
            document.body.style.overflow = '';
            document.body.style.position = '';
            document.body.style.width = '';
            document.body.style.top = '';
        };
    }, [isEditing]);

    useEffect(() => {
        if (isEditing || isCreating) {
            fetchTierFeatures();
        }
    }, [isEditing, isCreating]);

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
        setIsSaving(true);
        setError(null);
        
        try {
            const url = isCreating ? '/api/membership-tiers' : `/api/membership-tiers/${selectedTier.id}`;
            const method = isCreating ? 'POST' : 'PUT';
            
            const payload = isCreating ? {
                ...selectedTier,
                slug: selectedTier.name.toLowerCase().replace(/\s+/g, '-'),
            } : selectedTier;
            
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload)
            });
            
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || `Failed to ${isCreating ? 'create' : 'save'} tier`);
            }
            
            await fetchTiers();
            setSuccessMessage(`Tier ${isCreating ? 'created' : 'updated'} successfully`);
            setTimeout(() => {
                setIsEditing(false);
                setIsCreating(false);
                setSuccessMessage(null);
            }, 1000);
        } catch (err: any) {
            setError(err.message || `Failed to ${isCreating ? 'create' : 'save'} tier`);
        } finally {
            setIsSaving(false);
        }
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
        setSyncing(true);
        try {
            const res = await apiRequest('/api/admin/stripe/sync-products', { 
                method: 'POST'
            });
            if (res.ok && res.data?.success) {
                const data = res.data;
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
                alert(message);
                await fetchTiers();
            } else {
                const errorMsg = res.data?.message || res.error || 'Unknown error';
                if (errorMsg.includes('connection not found')) {
                    alert('Stripe sync failed: Stripe is not configured for this environment. Please set up Stripe live keys in Replit\'s Integrations panel before publishing.');
                } else {
                    alert('Sync failed: ' + errorMsg);
                }
            }
        } catch (err) {
            alert('Sync failed: Network error');
        } finally {
            setSyncing(false);
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-12">
                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-4xl text-primary/70">progress_activity</span>
            </div>
        );
    }

    return (
        <div className="animate-pop-in">
            {/* Sub-tabs navigation */}
            <div className="flex gap-1 p-1 bg-gray-100 dark:bg-black/30 rounded-xl mb-6 overflow-x-auto">
                {SUB_TABS.map(tab => (
                    <button
                        key={tab.key}
                        onClick={() => setActiveSubTab(tab.key)}
                        className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
                            activeSubTab === tab.key
                                ? 'bg-white dark:bg-white/10 text-primary dark:text-white shadow-sm'
                                : 'text-gray-600 dark:text-gray-400 hover:text-primary dark:hover:text-white'
                        }`}
                    >
                        <span aria-hidden="true" className="material-symbols-outlined text-lg">{tab.icon}</span>
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
                                            className="bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border border-gray-200 dark:border-white/20 cursor-pointer hover:border-primary/30 transition-all animate-slide-up-stagger"
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


            <ModalShell isOpen={isEditing && !!selectedTier} onClose={() => { setIsEditing(false); setIsCreating(false); }} title={isCreating ? 'New Tier' : `Edit Tier: ${selectedTier?.name || ''}`} size="full">
                <div className="p-6 pt-4 space-y-6">
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

                    <div>
                        <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">Display Fields</h4>
                        <div className="space-y-3">
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Name</label>
                                    <input 
                                        className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" 
                                        value={selectedTier?.name || ''} 
                                        onChange={e => selectedTier && setSelectedTier({...selectedTier, name: e.target.value})} 
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Price String</label>
                                    <input 
                                        className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" 
                                        value={selectedTier?.price_string || ''} 
                                        onChange={e => selectedTier && setSelectedTier({...selectedTier, price_string: e.target.value})} 
                                        placeholder="e.g., $199/mo"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Description</label>
                                <textarea 
                                    className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all resize-none" 
                                    rows={2}
                                    value={selectedTier?.description || ''} 
                                    onChange={e => selectedTier && setSelectedTier({...selectedTier, description: e.target.value})} 
                                />
                            </div>
                            <div>
                                <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Button Text</label>
                                <input 
                                    className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" 
                                    value={selectedTier?.button_text || ''} 
                                    onChange={e => selectedTier && setSelectedTier({...selectedTier, button_text: e.target.value})} 
                                />
                            </div>
                            <label className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/25 cursor-pointer hover:bg-gray-100 dark:hover:bg-black/30 transition-colors mt-2">
                                <span className="text-sm text-primary dark:text-white">Show in Compare Table</span>
                                <Toggle
                                    checked={selectedTier?.show_in_comparison || false}
                                    onChange={(val) => selectedTier && setSelectedTier({...selectedTier, show_in_comparison: val})}
                                    label="Show in Compare Table"
                                />
                            </label>
                        </div>
                    </div>

                    <div>
                        <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">Stripe Pricing</h4>
                        <div className="space-y-3">
                            {selectedTier?.stripe_price_id && (
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
                            )}
                            <div>
                                <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Linked Stripe Price</label>
                                <select
                                    className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                                    value={selectedTier?.stripe_price_id || ''}
                                    onChange={e => {
                                        if (!selectedTier) return;
                                        const priceId = e.target.value;
                                        if (!priceId) {
                                            setSelectedTier({
                                                ...selectedTier,
                                                stripe_price_id: null,
                                                stripe_product_id: null,
                                                price_cents: null
                                            });
                                        } else {
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
                            <div>
                                <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">
                                    Price (Cents)
                                    {selectedTier?.stripe_price_id && (
                                        <span className="ml-2 text-indigo-600 dark:text-indigo-400 normal-case font-normal">Auto-filled from Stripe</span>
                                    )}
                                </label>
                                <input
                                    type="number"
                                    className={`w-full border border-gray-200 dark:border-white/20 p-2.5 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all ${
                                        selectedTier?.stripe_price_id
                                            ? 'bg-gray-100 dark:bg-black/50 cursor-not-allowed'
                                            : 'bg-gray-50 dark:bg-black/30'
                                    }`}
                                    value={selectedTier?.price_cents || ''}
                                    onChange={e => selectedTier && !selectedTier.stripe_price_id && setSelectedTier({...selectedTier, price_cents: parseInt(e.target.value) || null})}
                                    readOnly={!!selectedTier?.stripe_price_id}
                                    placeholder="e.g., 19900 for $199"
                                />
                            </div>
                        </div>
                    </div>

                    <div>
                        <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">Limits & Quotas</h4>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Daily Sim Minutes</label>
                                <input 
                                    type="number"
                                    className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" 
                                    value={selectedTier?.daily_sim_minutes || 0} 
                                    onChange={e => selectedTier && setSelectedTier({...selectedTier, daily_sim_minutes: parseInt(e.target.value) || 0})} 
                                />
                            </div>
                            <div>
                                <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Guest Passes / Month</label>
                                <input 
                                    type="number"
                                    className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" 
                                    value={selectedTier?.guest_passes_per_month || 0} 
                                    onChange={e => selectedTier && setSelectedTier({...selectedTier, guest_passes_per_month: parseInt(e.target.value) || 0})} 
                                />
                            </div>
                            <div>
                                <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Booking Window (Days)</label>
                                <input 
                                    type="number"
                                    className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" 
                                    value={selectedTier?.booking_window_days || 0} 
                                    onChange={e => selectedTier && setSelectedTier({...selectedTier, booking_window_days: parseInt(e.target.value) || 0})} 
                                />
                            </div>
                            <div>
                                <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Daily Conf Room Minutes</label>
                                <input 
                                    type="number"
                                    className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" 
                                    value={selectedTier?.daily_conf_room_minutes || 0} 
                                    onChange={e => selectedTier && setSelectedTier({...selectedTier, daily_conf_room_minutes: parseInt(e.target.value) || 0})} 
                                />
                            </div>
                        </div>
                    </div>

                    <div>
                        <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">Permissions</h4>
                        <div className="grid grid-cols-2 gap-2">
                            {selectedTier && BOOLEAN_FIELDS.map(({ key, label }) => (
                                <label key={key} className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/25 cursor-pointer hover:bg-gray-100 dark:hover:bg-black/30 transition-colors">
                                    <span className="text-sm text-primary dark:text-white pr-2">{label}</span>
                                    <Toggle
                                        checked={!!selectedTier[key as keyof MembershipTier]}
                                        onChange={(val) => setSelectedTier({...selectedTier, [key]: val})}
                                        label={label}
                                    />
                                </label>
                            ))}
                        </div>
                    </div>

                    <div>
                        <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">Tier Features</h4>
                        {featuresLoading ? (
                            <div className="flex items-center justify-center py-6">
                                <span aria-hidden="true" className="material-symbols-outlined animate-spin text-2xl text-gray-400">progress_activity</span>
                            </div>
                        ) : (
                            <>
                                <div className="space-y-2 mb-4 max-h-64 overflow-y-auto">
                                    {tierFeatures.filter(f => f.isActive).map(feature => {
                                        const tierId = selectedTier?.id;
                                        const currentValue = tierId && feature.values[tierId] ? feature.values[tierId].value : 
                                            (feature.valueType === 'boolean' ? false : feature.valueType === 'number' ? 0 : '');
                                        
                                        return (
                                            <div key={feature.id} className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/25">
                                                <div className="flex items-center gap-3 flex-1 min-w-0">
                                                    <span aria-hidden="true" className="material-symbols-outlined text-gray-500 dark:text-gray-400 text-lg shrink-0">
                                                        {feature.valueType === 'boolean' ? 'check_circle' : feature.valueType === 'number' ? 'tag' : 'text_fields'}
                                                    </span>
                                                    {editingLabelId === feature.id ? (
                                                        <input
                                                            type="text"
                                                            className="flex-1 border border-primary bg-white dark:bg-black/30 px-2 py-1 rounded text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
                                                            defaultValue={feature.displayLabel}
                                                            autoFocus
                                                            onBlur={(e) => {
                                                                if (e.target.value.trim() && e.target.value !== feature.displayLabel) {
                                                                    updateFeatureLabel(feature.id, e.target.value.trim());
                                                                }
                                                                setEditingLabelId(null);
                                                            }}
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter') {
                                                                    (e.target as HTMLInputElement).blur();
                                                                } else if (e.key === 'Escape') {
                                                                    setEditingLabelId(null);
                                                                }
                                                            }}
                                                        />
                                                    ) : (
                                                        <span 
                                                            className="text-sm text-primary dark:text-white font-medium truncate cursor-pointer hover:text-primary/80"
                                                            onClick={() => setEditingLabelId(feature.id)}
                                                            title="Click to edit label"
                                                        >
                                                            {feature.displayLabel}
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-2 shrink-0">
                                                    {feature.valueType === 'boolean' && selectedTier?.id && (
                                                        <Toggle
                                                            checked={currentValue === true}
                                                            onChange={(val) => updateFeatureValue(feature.id, selectedTier.id, val)}
                                                            label={feature.displayLabel}
                                                        />
                                                    )}
                                                    {feature.valueType === 'number' && selectedTier?.id && (
                                                        <input
                                                            type="number"
                                                            className="w-20 border border-gray-200 dark:border-white/20 bg-white dark:bg-black/30 px-2 py-1 rounded-lg text-sm text-primary dark:text-white text-right focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
                                                            defaultValue={typeof currentValue === 'number' ? currentValue : 0}
                                                            onChange={(e) => debouncedUpdateFeatureValue(feature.id, selectedTier.id, parseFloat(e.target.value) || 0)}
                                                        />
                                                    )}
                                                    {feature.valueType === 'text' && selectedTier?.id && (
                                                        <input
                                                            type="text"
                                                            className="w-32 border border-gray-200 dark:border-white/20 bg-white dark:bg-black/30 px-2 py-1 rounded-lg text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
                                                            defaultValue={typeof currentValue === 'string' ? currentValue : ''}
                                                            onChange={(e) => debouncedUpdateFeatureValue(feature.id, selectedTier.id, e.target.value)}
                                                            placeholder="Value..."
                                                        />
                                                    )}
                                                    {!selectedTier?.id && (
                                                        <span className="text-xs text-gray-400 italic">Save tier first</span>
                                                    )}
                                                    <button
                                                        type="button"
                                                        aria-label={`Delete ${feature.displayLabel}`}
                                                        onClick={() => deleteFeature(feature.id)}
                                                        className="text-gray-400 hover:text-red-500 transition-colors p-1"
                                                    >
                                                        <span aria-hidden="true" className="material-symbols-outlined text-base">delete</span>
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                    {tierFeatures.filter(f => f.isActive).length === 0 && (
                                        <div className="text-center py-4 text-gray-500 dark:text-gray-400 text-sm">
                                            No features defined yet. Add one below.
                                        </div>
                                    )}
                                </div>

                                <div className="border-t border-gray-200 dark:border-white/10 pt-3 mt-3">
                                    <p className="text-[10px] uppercase font-bold text-gray-600 dark:text-gray-500 mb-2">Add New Feature</p>
                                    <div className="flex gap-2">
                                        <input
                                            type="text"
                                            className="flex-1 border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 px-2 py-1.5 rounded-lg text-primary dark:text-white placeholder:text-gray-500 focus:ring-2 focus:ring-primary focus:border-transparent outline-none text-sm"
                                            placeholder="Feature key (e.g., priority_support)"
                                            value={newFeatureForm.key}
                                            onChange={e => setNewFeatureForm(prev => ({ ...prev, key: e.target.value }))}
                                        />
                                        <input
                                            type="text"
                                            className="flex-1 border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 px-2 py-1.5 rounded-lg text-primary dark:text-white placeholder:text-gray-500 focus:ring-2 focus:ring-primary focus:border-transparent outline-none text-sm"
                                            placeholder="Display label"
                                            value={newFeatureForm.label}
                                            onChange={e => setNewFeatureForm(prev => ({ ...prev, label: e.target.value }))}
                                        />
                                        <select
                                            className="border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 px-2 py-1.5 rounded-lg text-primary dark:text-white text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
                                            value={newFeatureForm.type}
                                            onChange={e => setNewFeatureForm(prev => ({ ...prev, type: e.target.value as 'boolean' | 'number' | 'text' }))}
                                        >
                                            <option value="boolean">Boolean</option>
                                            <option value="number">Number</option>
                                            <option value="text">Text</option>
                                        </select>
                                        <button
                                            type="button"
                                            onClick={createFeature}
                                            disabled={!newFeatureForm.key.trim() || !newFeatureForm.label.trim()}
                                            className="px-3 py-1.5 bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                        >
                                            <span aria-hidden="true" className="material-symbols-outlined text-sm">add</span>
                                        </button>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>

                    <div>
                        <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
                            Highlighted Features 
                            <span className="text-gray-600 font-normal ml-1">({selectedTier?.highlighted_features?.length || 0}/4)</span>
                        </h4>
                        <p className="text-xs text-gray-600 dark:text-gray-500 mb-3">These appear as bullet points on the membership cards</p>
                        
                        <div className="space-y-2 mb-4">
                            {selectedTier && (selectedTier.highlighted_features || []).map((highlight, idx) => (
                                <div key={idx} className="flex items-center gap-2 p-3 rounded-xl bg-primary/10 dark:bg-primary/20 border border-primary">
                                    <span className="w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center shrink-0 text-xs font-bold">{idx + 1}</span>
                                    <input
                                        type="text"
                                        value={highlight}
                                        onChange={e => {
                                            const newHighlights = [...(selectedTier.highlighted_features || [])];
                                            newHighlights[idx] = e.target.value;
                                            setSelectedTier({...selectedTier, highlighted_features: newHighlights});
                                        }}
                                        className="flex-1 bg-transparent border-none text-sm text-primary dark:text-white font-medium focus:outline-none focus:ring-0"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const newHighlights = (selectedTier.highlighted_features || []).filter((_, i) => i !== idx);
                                            setSelectedTier({...selectedTier, highlighted_features: newHighlights});
                                        }}
                                        className="text-primary/80 hover:text-red-500 transition-colors"
                                    >
                                        <span aria-hidden="true" className="material-symbols-outlined text-lg">close</span>
                                    </button>
                                </div>
                            ))}
                        </div>

                        {selectedTier && (selectedTier.highlighted_features?.length || 0) < 4 && (
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    className="flex-1 border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all text-sm"
                                    placeholder="Add highlight (e.g., '60 min Daily Golf')..."
                                    onKeyDown={e => {
                                        if (e.key === 'Enter' && (e.target as HTMLInputElement).value.trim()) {
                                            const val = (e.target as HTMLInputElement).value.trim();
                                            setSelectedTier({
                                                ...selectedTier, 
                                                highlighted_features: [...(selectedTier.highlighted_features || []), val]
                                            });
                                            (e.target as HTMLInputElement).value = '';
                                        }
                                    }}
                                />
                                <button
                                    type="button"
                                    onClick={e => {
                                        const input = (e.currentTarget.previousElementSibling as HTMLInputElement);
                                        if (input.value.trim()) {
                                            setSelectedTier({
                                                ...selectedTier, 
                                                highlighted_features: [...(selectedTier.highlighted_features || []), input.value.trim()]
                                            });
                                            input.value = '';
                                        }
                                    }}
                                    className="px-3 py-2 bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-white rounded-xl hover:bg-gray-200 dark:hover:bg-white/20 transition-colors"
                                >
                                    <span aria-hidden="true" className="material-symbols-outlined text-sm">add</span>
                                </button>
                            </div>
                        )}

                        {selectedTier && (selectedTier.highlighted_features?.length || 0) < 4 && tierFeatures.filter(f => f.isActive).length > 0 && (
                            <div className="mt-3">
                                <p className="text-[10px] uppercase font-bold text-gray-600 dark:text-gray-500 mb-2">Quick add from features:</p>
                                <div className="flex flex-wrap gap-1.5">
                                    {tierFeatures.filter(f => f.isActive).map(feature => {
                                        const isAlreadyHighlighted = selectedTier.highlighted_features?.includes(feature.displayLabel);
                                        if (isAlreadyHighlighted) return null;
                                        return (
                                            <button 
                                                key={feature.id}
                                                type="button"
                                                onClick={() => handleHighlightToggle(feature.displayLabel)}
                                                className="px-2.5 py-1 text-xs rounded-lg bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-400 hover:bg-primary/10 hover:text-primary dark:hover:text-white transition-colors"
                                            >
                                                + {feature.displayLabel}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="flex gap-3 justify-end pt-4 border-t border-gray-200 dark:border-white/25">
                        <button 
                            onClick={() => setIsEditing(false)} 
                            className="px-5 py-2.5 text-gray-500 dark:text-white/80 font-bold hover:bg-gray-100 dark:hover:bg-white/10 rounded-xl transition-colors"
                        >
                            Cancel
                        </button>
                        <button 
                            onClick={handleSave} 
                            disabled={isSaving}
                            className="px-6 py-2.5 bg-primary text-white rounded-xl font-bold shadow-md hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2"
                        >
                            {isSaving && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>}
                            {isSaving ? 'Saving...' : 'Save Changes'}
                        </button>
                    </div>
                </div>
            </ModalShell>

            {activeSubTab === 'tiers' && (() => {
                const subscriptionTiers = tiers.filter(t => t.product_type !== 'one_time');
                return (
                <>
                    <div className="flex justify-between items-center mb-6">
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                            {subscriptionTiers.length} membership tier{subscriptionTiers.length !== 1 ? 's' : ''}
                        </p>
                        <button 
                            onClick={handleSyncStripe}
                            disabled={syncing}
                            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white rounded-lg transition-colors"
                        >
                            <span className={`material-symbols-outlined ${syncing ? 'animate-spin' : ''}`}>sync</span>
                            {syncing ? 'Syncing...' : 'Sync to Stripe'}
                        </button>
                    </div>
                    {subscriptionTiers.length === 0 ? (
                        <div className="text-center py-12 px-6 rounded-2xl border-2 border-dashed border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-white/5">
                            <span aria-hidden="true" className="material-symbols-outlined text-5xl mb-4 text-gray-500 dark:text-white/20">loyalty</span>
                            <h3 className="text-lg font-bold mb-2 text-gray-600 dark:text-white/70">No tiers found</h3>
                            <p className="text-sm text-gray-500 dark:text-white/70 max-w-xs mx-auto">
                                Membership tiers will appear here once configured.
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-3 animate-slide-up-stagger" style={{ '--stagger-index': 0 } as React.CSSProperties}>
                            {subscriptionTiers.map((tier, index) => (
                                <div 
                                    key={tier.id} 
                                    onClick={() => openEdit(tier)}
                                    className="bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border border-gray-200 dark:border-white/20 cursor-pointer hover:border-primary/30 transition-all animate-slide-up-stagger"
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
        </div>
    );
};

export default TiersTab;

import React, { useState, useEffect, useRef } from 'react';
import ModalShell from '../../../components/ModalShell';
import Toggle from '../../../components/Toggle';
import FloatingActionButton from '../../../components/FloatingActionButton';
import ProductsSubTab from './ProductsSubTab';
import DiscountsSubTab from './DiscountsSubTab';

type SubTab = 'tiers' | 'products' | 'fees' | 'discounts';

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
    const [newFeatureKey, setNewFeatureKey] = useState('');
    const [syncing, setSyncing] = useState(false);
    const [stripePrices, setStripePrices] = useState<StripePrice[]>([]);
    const [loadingPrices, setLoadingPrices] = useState(false);

    const SUB_TABS: { key: SubTab; label: string; icon: string }[] = [
        { key: 'tiers', label: 'Tiers', icon: 'layers' },
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
            if (res.ok) {
                const data = await res.json();
                setStripePrices(data.prices || []);
            }
        } catch (err) {
            console.error('Failed to fetch Stripe prices:', err);
        } finally {
            setLoadingPrices(false);
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

    const handleAddFeature = () => {
        if (!selectedTier || !newFeatureKey.trim()) return;
        const key = newFeatureKey.trim();
        setSelectedTier({
            ...selectedTier,
            all_features: { ...selectedTier.all_features, [key]: true }
        });
        setNewFeatureKey('');
    };

    const handleRemoveFeature = (key: string) => {
        if (!selectedTier) return;
        const newFeatures = { ...selectedTier.all_features };
        delete newFeatures[key];
        setSelectedTier({
            ...selectedTier,
            all_features: newFeatures,
            highlighted_features: selectedTier.highlighted_features.filter(f => f !== key)
        });
    };

    const handleToggleFeature = (key: string) => {
        if (!selectedTier) return;
        setSelectedTier({
            ...selectedTier,
            all_features: {
                ...selectedTier.all_features,
                [key]: !selectedTier.all_features[key]
            }
        });
    };

    const handleSyncStripe = async () => {
        setSyncing(true);
        try {
            const res = await fetch('/api/admin/stripe/sync-products', { 
                method: 'POST',
                credentials: 'include'
            });
            const data = await res.json();
            if (res.ok && data.success) {
                alert(`Synced ${data.synced} products to Stripe`);
            } else {
                const errorMsg = data.message || data.error || 'Unknown error';
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
                                            className="bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border border-gray-200 dark:border-white/20 cursor-pointer hover:border-primary/30 transition-all animate-pop-in"
                                            style={{animationDelay: `${0.05 + index * 0.03}s`}}
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
                                <div className="flex items-center gap-2 p-3 rounded-xl bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-500/30">
                                    <span aria-hidden="true" className="material-symbols-outlined text-indigo-600 dark:text-indigo-400">link</span>
                                    <span className="text-sm font-medium text-indigo-700 dark:text-indigo-300">Linked to Stripe</span>
                                    <span className="text-xs text-indigo-600 dark:text-indigo-400 ml-auto">{selectedTier.stripe_price_id}</span>
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
                        <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">All Features</h4>
                        <div className="space-y-2 mb-3">
                            {selectedTier && Object.entries(selectedTier.all_features || {}).map(([key, enabled]) => (
                                <div key={key} className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/25">
                                    <div className="flex items-center gap-3">
                                        <button
                                            type="button"
                                            role="checkbox"
                                            aria-checked={enabled}
                                            aria-label={`Toggle ${key}`}
                                            onClick={() => handleToggleFeature(key)}
                                            className={`w-6 h-6 rounded-md flex items-center justify-center transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ${
                                                enabled 
                                                    ? 'bg-primary text-white shadow-sm' 
                                                    : 'bg-white dark:bg-[#39393D] border-2 border-gray-300 dark:border-gray-600'
                                            }`}
                                        >
                                            {enabled && <span aria-hidden="true" className="material-symbols-outlined text-base font-bold">check</span>}
                                        </button>
                                        <span className={`text-sm ${enabled ? 'text-primary dark:text-white font-medium' : 'text-gray-600 line-through'}`}>{key}</span>
                                    </div>
                                    <button
                                        type="button"
                                        aria-label={`Remove ${key}`}
                                        onClick={() => handleRemoveFeature(key)}
                                        className="text-gray-600 hover:text-red-500 transition-colors p-1 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 rounded"
                                    >
                                        <span aria-hidden="true" className="material-symbols-outlined text-lg">close</span>
                                    </button>
                                </div>
                            ))}
                        </div>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                className="flex-1 border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2 rounded-xl text-primary dark:text-white placeholder:text-gray-500 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all text-sm"
                                placeholder="Add new feature..."
                                value={newFeatureKey}
                                onChange={e => setNewFeatureKey(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && handleAddFeature()}
                            />
                            <button
                                type="button"
                                onClick={handleAddFeature}
                                className="px-3 py-2 bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-white rounded-xl hover:bg-gray-200 dark:hover:bg-white/20 transition-colors"
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-sm">add</span>
                            </button>
                        </div>
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

                        {selectedTier && (selectedTier.highlighted_features?.length || 0) < 4 && Object.keys(selectedTier.all_features || {}).length > 0 && (
                            <div className="mt-3">
                                <p className="text-[10px] uppercase font-bold text-gray-600 dark:text-gray-500 mb-2">Quick add from features:</p>
                                <div className="flex flex-wrap gap-1.5">
                                    {Object.entries(selectedTier.all_features || {}).map(([key, featureData]) => {
                                        let label = key;
                                        if (typeof featureData === 'object' && featureData !== null && 'label' in (featureData as object)) {
                                            label = String((featureData as Record<string, unknown>).label);
                                        }
                                        const isAlreadyHighlighted = selectedTier.highlighted_features?.includes(label);
                                        if (isAlreadyHighlighted) return null;
                                        return (
                                            <button 
                                                key={key}
                                                type="button"
                                                onClick={() => handleHighlightToggle(label)}
                                                className="px-2.5 py-1 text-xs rounded-lg bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-400 hover:bg-primary/10 hover:text-primary dark:hover:text-white transition-colors"
                                            >
                                                + {label}
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
                        <div className="space-y-3 animate-pop-in" style={{animationDelay: '0.1s'}}>
                            {subscriptionTiers.map((tier, index) => (
                                <div 
                                    key={tier.id} 
                                    onClick={() => openEdit(tier)}
                                    className="bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border border-gray-200 dark:border-white/20 cursor-pointer hover:border-primary/30 transition-all animate-pop-in"
                                    style={{animationDelay: `${0.15 + index * 0.03}s`}}
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

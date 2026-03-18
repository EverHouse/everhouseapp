import React from 'react';
import { type QueryClient } from '@tanstack/react-query';
import SlideUpDrawer from '../../../../components/SlideUpDrawer';
import Toggle from '../../../../components/Toggle';
import type { MembershipTier, TierFeature, StripePrice } from './tiersTypes';
import { BOOLEAN_FIELDS } from './tiersTypes';
import CompareTableSection from './CompareTableSection';

interface TierEditorDrawerProps {
    isEditing: boolean;
    isCreating: boolean;
    selectedTier: MembershipTier | null;
    setSelectedTier: (tier: MembershipTier | null) => void;
    setIsEditing: (v: boolean) => void;
    setIsCreating: (v: boolean) => void;
    error: string | null;
    successMessage: string | null;
    setSuccessMessage: (v: string | null) => void;
    saveTierMutation: { isPending: boolean };
    handleSave: () => void;
    stripePrices: StripePrice[];
    loadingPrices: boolean;
    tierFeatures: TierFeature[];
    featuresLoading: boolean;
    editingLabelId: number | null;
    setEditingLabelId: (v: number | null) => void;
    newFeatureForm: { key: string; label: string; type: 'boolean' | 'number' | 'text' };
    setNewFeatureForm: (v: { key: string; label: string; type: 'boolean' | 'number' | 'text' }) => void;
    isReordering: boolean;
    handleReorderFeature: (featureId: number, direction: 'up' | 'down') => void;
    handleHighlightToggle: (feature: string) => void;
    debouncedUpdateFeatureValue: (featureId: number, tierId: number, value: string | boolean | number) => void;
    updateFeatureValueMutation: { isPending: boolean };
    updateFeatureLabelMutation: { mutate: (v: { featureId: number; displayLabel: string }) => void };
    createFeature: () => void;
    createFeatureMutation: { isPending: boolean };
    deleteFeature: (featureId: number) => void;
    queryClient: QueryClient;
}

const TierEditorDrawer: React.FC<TierEditorDrawerProps> = ({
    isEditing,
    isCreating,
    selectedTier,
    setSelectedTier,
    setIsEditing,
    setIsCreating,
    error,
    successMessage,
    setSuccessMessage,
    saveTierMutation,
    handleSave,
    stripePrices,
    tierFeatures,
    featuresLoading,
    editingLabelId,
    setEditingLabelId,
    newFeatureForm,
    setNewFeatureForm,
    isReordering,
    handleReorderFeature,
    handleHighlightToggle,
    debouncedUpdateFeatureValue,
    updateFeatureValueMutation,
    updateFeatureLabelMutation,
    createFeature,
    createFeatureMutation,
    deleteFeature,
    queryClient,
}) => {
    const isMembershipTier = selectedTier?.product_type !== 'one_time';

    return (
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

                <div>
                    <h4 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400 mb-1">{isMembershipTier ? 'MEMBERSHIP PAGE CARD' : 'PRODUCT DETAILS'}</h4>
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
                                        onChange={e => selectedTier && setSelectedTier({...selectedTier, sort_order: parseInt(e.target.value, 10) || 0})} 
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
                                    <h4 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400 mb-3">
                                        Card Features
                                        {selectedTier?.stripe_product_id ? (
                                            <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 text-[10px] normal-case font-semibold">
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
                                                {BOOLEAN_FIELDS.filter(f => (selectedTier as unknown as Record<string, boolean | string | number | null | undefined>)?.[f.key]).map(field => (
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

                <div className="border-t-2 border-gray-200 dark:border-white/15 pt-6">
                    <h4 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400 mb-1">STRIPE-MANAGED SETTINGS</h4>
                    <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-4">These values sync from Stripe. When linked to a Stripe product, edit them in the Stripe Dashboard.</p>
                    <div className="space-y-6">
                        <div>
                            <h5 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400 mb-3">Stripe Pricing</h5>
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
                                                            stripe_price_id: priceId,
                                                            stripe_product_id: selectedPrice.productId,
                                                            price_cents: selectedPrice.amountCents
                                                        });
                                                    }
                                                }
                                            }}
                                        >
                                            <option value="">Select a Stripe price...</option>
                                            {stripePrices.map(p => (
                                                <option key={p.id} value={p.id}>
                                                    {p.productName} — {p.displayString}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                            </div>
                        </div>

                        {isMembershipTier && (
                            <>
                                <div>
                                    <h5 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400 mb-3">
                                        Booking Permissions
                                        {selectedTier?.stripe_product_id && (
                                            <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 text-[10px] normal-case font-semibold">
                                                <span aria-hidden="true" className="material-symbols-outlined text-xs">cloud</span>
                                                From Stripe metadata
                                            </span>
                                        )}
                                    </h5>
                                    <div className="space-y-3">
                                        {BOOLEAN_FIELDS.map(field => (
                                            <label key={field.key} className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/25 cursor-pointer hover:bg-gray-100 dark:hover:bg-black/30 transition-colors">
                                                <span className="text-sm text-primary dark:text-white">{field.label}</span>
                                                <Toggle
                                                    checked={(selectedTier as unknown as Record<string, boolean>)?.[field.key] || false}
                                                    onChange={(val) => selectedTier && setSelectedTier({...selectedTier, [field.key]: val} as MembershipTier)}
                                                    label={field.label}
                                                />
                                            </label>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <h5 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400 mb-3">Numeric Limits</h5>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div>
                                            <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Daily Sim Minutes</label>
                                            <input 
                                                type="number" 
                                                className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white" 
                                                value={selectedTier?.daily_sim_minutes ?? 0}
                                                onChange={e => selectedTier && setSelectedTier({...selectedTier, daily_sim_minutes: parseInt(e.target.value, 10) || 0})}
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Guest Passes/Year</label>
                                            <input 
                                                type="number" 
                                                className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white" 
                                                value={selectedTier?.guest_passes_per_year ?? 0}
                                                onChange={e => selectedTier && setSelectedTier({...selectedTier, guest_passes_per_year: parseInt(e.target.value, 10) || 0})}
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Booking Window (days)</label>
                                            <input 
                                                type="number" 
                                                className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white" 
                                                value={selectedTier?.booking_window_days ?? 7}
                                                onChange={e => selectedTier && setSelectedTier({...selectedTier, booking_window_days: parseInt(e.target.value, 10) || 7})}
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Daily Conf Room Min</label>
                                            <input 
                                                type="number" 
                                                className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white" 
                                                value={selectedTier?.daily_conf_room_minutes ?? 0}
                                                onChange={e => selectedTier && setSelectedTier({...selectedTier, daily_conf_room_minutes: parseInt(e.target.value, 10) || 0})}
                                            />
                                        </div>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                </div>

                {(() => {
                    const isWalletSection = true;
                    return isWalletSection && (
                    <div className="border-t-2 border-gray-200 dark:border-white/15 pt-6">
                        <h4 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400 mb-1">WALLET PASS COLORS</h4>
                        <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-4">Customize the Apple/Google wallet pass appearance for this tier.</p>
                        <div className="space-y-3">
                            <div className="grid grid-cols-3 gap-3">
                                <div>
                                    <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Background</label>
                                    <input 
                                        type="text" 
                                        className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white font-mono text-sm" 
                                        value={selectedTier?.wallet_pass_bg_color || ''}
                                        onChange={e => selectedTier && setSelectedTier({...selectedTier, wallet_pass_bg_color: e.target.value || null})}
                                        placeholder="#1B2E1B"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Foreground</label>
                                    <input 
                                        type="text" 
                                        className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white font-mono text-sm" 
                                        value={selectedTier?.wallet_pass_foreground_color || ''}
                                        onChange={e => selectedTier && setSelectedTier({...selectedTier, wallet_pass_foreground_color: e.target.value || null})}
                                        placeholder="#FFFFFF"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400">Label</label>
                                    <input 
                                        type="text" 
                                        className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-primary dark:text-white font-mono text-sm" 
                                        value={selectedTier?.wallet_pass_label_color || ''}
                                        onChange={e => selectedTier && setSelectedTier({...selectedTier, wallet_pass_label_color: e.target.value || null})}
                                        placeholder="#6B7280"
                                    />
                                </div>
                            </div>
                        </div>
                        {(selectedTier?.wallet_pass_bg_color || selectedTier?.wallet_pass_foreground_color || selectedTier?.wallet_pass_label_color) && (
                            <div className="mt-3 p-3 rounded-xl border border-gray-200 dark:border-white/20" style={{ backgroundColor: selectedTier?.wallet_pass_bg_color || '#CCCCCC' }}>
                                <span className="text-[10px] uppercase font-bold" style={{ color: selectedTier?.wallet_pass_label_color || '#666666' }}>MEMBER</span>
                                <p className="text-sm font-semibold" style={{ color: selectedTier?.wallet_pass_foreground_color || '#333333' }}>Preview Name</p>
                            </div>
                        )}
                    </div>
                    );
                })()}

                {isMembershipTier && selectedTier && (
                    <CompareTableSection
                        selectedTier={selectedTier}
                        setSelectedTier={setSelectedTier}
                        tierFeatures={tierFeatures}
                        featuresLoading={featuresLoading}
                        editingLabelId={editingLabelId}
                        setEditingLabelId={setEditingLabelId}
                        newFeatureForm={newFeatureForm}
                        setNewFeatureForm={setNewFeatureForm}
                        isReordering={isReordering}
                        handleReorderFeature={handleReorderFeature}
                        debouncedUpdateFeatureValue={debouncedUpdateFeatureValue}
                        updateFeatureValueMutation={updateFeatureValueMutation}
                        updateFeatureLabelMutation={updateFeatureLabelMutation}
                        createFeature={createFeature}
                        createFeatureMutation={createFeatureMutation}
                        deleteFeature={deleteFeature}
                        queryClient={queryClient}
                    />
                )}
            </div>
        </SlideUpDrawer>
    );
};

export default TierEditorDrawer;

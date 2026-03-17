import React from 'react';
import { type QueryClient } from '@tanstack/react-query';
import Toggle from '../../../../components/Toggle';
import type { MembershipTier, TierFeature } from './tiersTypes';

interface CompareTableSectionProps {
    selectedTier: MembershipTier;
    setSelectedTier: (tier: MembershipTier | null) => void;
    tierFeatures: TierFeature[];
    featuresLoading: boolean;
    editingLabelId: number | null;
    setEditingLabelId: (v: number | null) => void;
    newFeatureForm: { key: string; label: string; type: 'boolean' | 'number' | 'text' };
    setNewFeatureForm: (v: { key: string; label: string; type: 'boolean' | 'number' | 'text' }) => void;
    isReordering: boolean;
    handleReorderFeature: (featureId: number, direction: 'up' | 'down') => void;
    debouncedUpdateFeatureValue: (featureId: number, tierId: number, value: string | boolean | number) => void;
    updateFeatureValueMutation: { isPending: boolean };
    updateFeatureLabelMutation: { mutate: (v: { featureId: number; displayLabel: string }) => void };
    createFeature: () => void;
    createFeatureMutation: { isPending: boolean };
    deleteFeature: (featureId: number) => void;
    queryClient: QueryClient;
}

const CompareTableSection: React.FC<CompareTableSectionProps> = ({
    selectedTier,
    setSelectedTier,
    tierFeatures,
    featuresLoading,
    editingLabelId,
    setEditingLabelId,
    newFeatureForm,
    setNewFeatureForm,
    isReordering,
    handleReorderFeature,
    debouncedUpdateFeatureValue,
    updateFeatureValueMutation,
    updateFeatureLabelMutation,
    createFeature,
    createFeatureMutation,
    deleteFeature,
    queryClient,
}) => {
    return (
        <div className="border-t-2 border-gray-200 dark:border-white/15 pt-6">
            <h4 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400 mb-1">COMPARE TABLE</h4>
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
                        <h5 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400">
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
                                                    role="button"
                                                    tabIndex={0}
                                                    onClick={() => setEditingLabelId(feature.id)}
                                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditingLabelId(feature.id); } }}
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
                                            loading={updateFeatureValueMutation.isPending}
                                        />
                                    ) : feature.valueType === 'number' ? (
                                        <input
                                            type="number"
                                            className="w-full border border-gray-200 dark:border-white/20 bg-white dark:bg-black/30 p-2 rounded-lg text-sm text-primary dark:text-white"
                                            value={feature.values[selectedTier.id]?.value as number || ''}
                                            onChange={e => {
                                                const newVal = parseInt(e.target.value, 10) || 0;
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
                                onChange={e => setNewFeatureForm({ ...newFeatureForm, key: e.target.value })}
                            />
                            <input
                                className="border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2 rounded-lg text-sm text-primary dark:text-white placeholder:text-gray-400"
                                placeholder="Label"
                                value={newFeatureForm.label}
                                onChange={e => setNewFeatureForm({ ...newFeatureForm, label: e.target.value })}
                            />
                            <select
                                className="border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2 rounded-lg text-sm text-primary dark:text-white"
                                value={newFeatureForm.type}
                                onChange={e => setNewFeatureForm({ ...newFeatureForm, type: e.target.value as 'boolean' | 'number' | 'text' })}
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
};

export default CompareTableSection;

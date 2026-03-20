import React from 'react';
import DiscountsSubTab from '../DiscountsSubTab';
import CafeTab from '../CafeTab';
import { TiersTabSkeleton } from '../../../../components/skeletons';
import { useTiersTab } from './useTiersTab';
import TierCardList from './TierCardList';
import TierEditorDrawer from './TierEditorDrawer';
import FeesSubTab from './FeesSubTab';
import type { SubTab } from './tiersTypes';
import Icon from '../../../../components/icons/Icon';

const SUB_TABS: { key: SubTab; label: string; icon: string }[] = [
    { key: 'tiers', label: 'Memberships', icon: 'layers' },
    { key: 'fees', label: 'Fees & Passes', icon: 'receipt_long' },
    { key: 'discounts', label: 'Discounts', icon: 'percent' },
    { key: 'cafe', label: 'Cafe Menu', icon: 'local_cafe' },
];

const TiersTab: React.FC = () => {
    const tab = useTiersTab();

    if (tab.isLoading) {
        return <TiersTabSkeleton />;
    }

    return (
        <div className="animate-page-enter">
            <div className="flex gap-1 p-1 bg-gray-100 dark:bg-black/30 rounded-xl mb-6 overflow-x-auto scrollbar-hide">
                {SUB_TABS.map(t => (
                    <button
                        key={t.key}
                        onClick={() => tab.setActiveSubTab(t.key)}
                        className={`flex items-center gap-1 px-2 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium whitespace-nowrap transition-all duration-fast flex-shrink-0 ${
                            tab.activeSubTab === t.key
                                ? 'bg-white dark:bg-white/10 text-primary dark:text-white shadow-sm'
                                : 'text-gray-600 dark:text-gray-400 hover:text-primary dark:hover:text-white'
                        }`}
                    >
                        <Icon name={t.icon} className="text-base sm:text-lg" />
                        {t.label}
                    </button>
                ))}
            </div>

            <div key={tab.activeSubTab} className="animate-content-enter">
                {tab.activeSubTab === 'fees' && (
                    <FeesSubTab tiers={tab.tiers} openEdit={tab.openEdit} openCreate={tab.openCreateOneTime} />
                )}
                {tab.activeSubTab === 'discounts' && <DiscountsSubTab />}
                {tab.activeSubTab === 'cafe' && <CafeTab />}

                <TierEditorDrawer
                    isEditing={tab.isEditing}
                    isCreating={tab.isCreating}
                    selectedTier={tab.selectedTier}
                    setSelectedTier={tab.setSelectedTier}
                    setIsEditing={tab.setIsEditing}
                    setIsCreating={tab.setIsCreating}
                    error={tab.error}
                    saveTierMutation={tab.saveTierMutation}
                    handleSave={tab.handleSave}
                    stripePrices={tab.stripePrices}
                    loadingPrices={tab.loadingPrices}
                    tierFeatures={tab.tierFeatures}
                    featuresLoading={tab.featuresLoading}
                    editingLabelId={tab.editingLabelId}
                    setEditingLabelId={tab.setEditingLabelId}
                    newFeatureForm={tab.newFeatureForm}
                    setNewFeatureForm={tab.setNewFeatureForm}
                    isReordering={tab.isReordering}
                    handleReorderFeature={tab.handleReorderFeature}
                    debouncedUpdateFeatureValue={tab.debouncedUpdateFeatureValue}
                    updateFeatureValueMutation={tab.updateFeatureValueMutation}
                    updateFeatureLabelMutation={tab.updateFeatureLabelMutation}
                    createFeature={tab.createFeature}
                    createFeatureMutation={tab.createFeatureMutation}
                    deleteFeature={tab.deleteFeature}
                    queryClient={tab.queryClient}
                />

                {tab.activeSubTab === 'tiers' && (
                    <TierCardList
                        tiers={tab.tiers}
                        stripeConnection={tab.stripeConnection}
                        syncStripePending={tab.syncStripeMutation.isPending}
                        pullFromStripePending={tab.pullFromStripeMutation.isPending}
                        openEdit={tab.openEdit}
                        openCreate={tab.openCreate}
                        handleSyncStripe={tab.handleSyncStripe}
                        handlePullFromStripe={tab.handlePullFromStripe}
                    />
                )}
            </div>
            <tab.ConfirmDialogComponent />
        </div>
    );
};

export default TiersTab;

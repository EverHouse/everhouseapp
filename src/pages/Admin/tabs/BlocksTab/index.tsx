import React from 'react';
import AvailabilityBlocksContent from '../../components/AvailabilityBlocksContent';
import { AnimatedPage } from '../../../../components/motion';
import { TabTransition } from '../../../../components/motion/TabTransition';
import FloatingActionButton from '../../../../components/FloatingActionButton';
import WalkingGolferSpinner from '../../../../components/WalkingGolferSpinner';
import { useBlocksData } from './useBlocksData';
import { NoticeList } from './NoticeList';
import { ClosureFormDrawer } from './ClosureFormDrawer';
import { ClosureReasonsSection, NoticeTypesSection, EditReasonDrawer, EditNoticeTypeDrawer } from './ConfigSections';

const BlocksTab: React.FC = () => {
    const data = useBlocksData();

    const configuredClosures = data.upcomingClosures;

    if (data.isLoading && data.closuresLoading) {
        return (
            <div className="flex items-center justify-center py-12">
                <WalkingGolferSpinner size="sm" />
            </div>
        );
    }

    return (
        <AnimatedPage className="space-y-6">
            <div className="flex items-center justify-between gap-3 flex-wrap animate-content-enter-delay-1">
                <div className="inline-flex bg-black/5 dark:bg-white/10 backdrop-blur-sm rounded-full p-1 relative">
                    <div
                        className="absolute top-1 bottom-1 bg-white dark:bg-white/20 shadow-md rounded-full transition-all duration-normal"
                        style={{
                            width: 'calc(50% - 4px)',
                            left: data.activeSubTab === 'notices' ? '4px' : 'calc(50% + 0px)',
                        }}
                    />
                    <button
                        onClick={() => data.setActiveSubTab('notices')}
                        className={`tactile-btn relative z-10 px-5 py-1.5 text-sm font-medium transition-colors duration-fast rounded-full flex items-center gap-1.5 ${
                            data.activeSubTab === 'notices'
                                ? 'text-primary dark:text-white'
                                : 'text-gray-500 dark:text-white/60'
                        }`}
                    >
                        <span aria-hidden="true" className="material-symbols-outlined text-[18px]">notifications</span>
                        Notices
                    </button>
                    <button
                        onClick={() => data.setActiveSubTab('blocks')}
                        className={`tactile-btn relative z-10 px-5 py-1.5 text-sm font-medium transition-colors duration-fast rounded-full flex items-center gap-1.5 ${
                            data.activeSubTab === 'blocks'
                                ? 'text-primary dark:text-white'
                                : 'text-gray-500 dark:text-white/60'
                        }`}
                    >
                        <span aria-hidden="true" className="material-symbols-outlined text-[18px]">event_busy</span>
                        Blocks
                    </button>
                </div>

                {data.activeSubTab === 'notices' && (
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => data.setShowClosureReasonsSection(!data.showClosureReasonsSection)}
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[4px] text-xs font-medium backdrop-blur-sm border transition-all duration-fast tactile-btn ${
                                data.showClosureReasonsSection
                                    ? 'bg-primary/10 dark:bg-white/15 border-primary/30 dark:border-white/20 text-primary dark:text-white'
                                    : 'bg-white/60 dark:bg-white/10 border-gray-200/50 dark:border-white/10 hover:bg-white/80 dark:hover:bg-white/15 text-gray-600 dark:text-white/70'
                            }`}
                        >
                            <span aria-hidden="true" className="material-symbols-outlined text-sm">settings</span>
                            Closure Reasons
                            <span className="bg-gray-200 dark:bg-white/20 text-gray-600 dark:text-white/70 px-1.5 py-0.5 rounded-[4px] text-[10px]">
                                {data.closureReasons.filter(r => r.isActive).length}
                            </span>
                        </button>
                        <button
                            onClick={() => data.setShowNoticeTypesSection(!data.showNoticeTypesSection)}
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[4px] text-xs font-medium backdrop-blur-sm border transition-all duration-fast tactile-btn ${
                                data.showNoticeTypesSection
                                    ? 'bg-primary/10 dark:bg-white/15 border-primary/30 dark:border-white/20 text-primary dark:text-white'
                                    : 'bg-white/60 dark:bg-white/10 border-gray-200/50 dark:border-white/10 hover:bg-white/80 dark:hover:bg-white/15 text-gray-600 dark:text-white/70'
                            }`}
                        >
                            <span aria-hidden="true" className="material-symbols-outlined text-sm">category</span>
                            Notice Types
                            <span className="bg-gray-200 dark:bg-white/20 text-gray-600 dark:text-white/70 px-1.5 py-0.5 rounded-[4px] text-[10px]">
                                {data.noticeTypes.length}
                            </span>
                        </button>
                    </div>
                )}
            </div>

            <TabTransition activeKey={data.activeSubTab}>
            <div className="animate-content-enter">
            {data.activeSubTab === 'blocks' && <AvailabilityBlocksContent />}

            {data.activeSubTab === 'notices' && (
            <>
            <div className="flex items-center gap-3 py-2 text-[10px] flex-wrap animate-content-enter">
                <div className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-red-500 inline-block"></span>
                    <span className="text-gray-500 dark:text-white/60">Blocks</span>
                </div>
                <div className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-amber-500 inline-block"></span>
                    <span className="text-gray-500 dark:text-white/60">Info</span>
                </div>
                <div className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-blue-500 inline-block"></span>
                    <span className="text-gray-500 dark:text-white/60">Draft</span>
                </div>
                <span className="text-gray-300 dark:text-white/20">|</span>
                <div className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-green-500 inline-block"></span>
                    <span className="text-gray-500 dark:text-white/60">Synced · Internal Calendar</span>
                </div>
            </div>

            {data.showClosureReasonsSection && (
                <ClosureReasonsSection
                    closureReasons={data.closureReasons}
                    newReasonLabel={data.newReasonLabel}
                    setNewReasonLabel={data.setNewReasonLabel}
                    handleAddClosureReason={data.handleAddClosureReason}
                    addClosureReasonMutation={data.addClosureReasonMutation}
                    openReasonDrawer={data.openReasonDrawer}
                    handleDeleteClosureReason={data.handleDeleteClosureReason}
                    handleReactivateClosureReason={data.handleReactivateClosureReason}
                />
            )}

            {data.showNoticeTypesSection && (
                <NoticeTypesSection
                    noticeTypes={data.noticeTypes}
                    newNoticeTypeName={data.newNoticeTypeName}
                    setNewNoticeTypeName={data.setNewNoticeTypeName}
                    handleAddNoticeType={data.handleAddNoticeType}
                    addNoticeTypeMutation={data.addNoticeTypeMutation}
                    openNoticeTypeDrawer={data.openNoticeTypeDrawer}
                    handleDeleteNoticeType={data.handleDeleteNoticeType}
                />
            )}

            <NoticeList
                configuredClosures={configuredClosures}
                pastClosures={data.pastClosures}
                closuresLoading={data.closuresLoading}
                closuresCount={data.closures.length}
                expandedNotices={data.expandedNotices}
                showPastAccordion={data.showPastAccordion}
                pastNoticesLimit={data.pastNoticesLimit}
                isBlocking={data.isBlocking}
                formatDate={data.formatDate}
                formatTime={data.formatTime}
                formatAffectedAreas={data.formatAffectedAreas}
                getAffectedAreasList={data.getAffectedAreasList}
                getMissingFields={data.getMissingFields}
                toggleNoticeExpand={data.toggleNoticeExpand}
                handleEditClosure={data.handleEditClosure}
                handleDeleteClosure={data.handleDeleteClosure}
                setShowPastAccordion={data.setShowPastAccordion}
                setPastNoticesLimit={data.setPastNoticesLimit}
            />

            <ClosureFormDrawer
                isOpen={data.isClosureModalOpen}
                editingClosureId={data.editingClosureId}
                closureForm={data.closureForm}
                setClosureForm={data.setClosureForm}
                touchedFields={data.touchedFields}
                markTouched={data.markTouched}
                closureValidation={data.closureValidation}
                isClosureFormValid={data.isClosureFormValid}
                noticeTypes={data.noticeTypes}
                closureReasons={data.closureReasons}
                bays={data.bays}
                isBlocking={data.isBlocking}
                formatAffectedAreas={data.formatAffectedAreas}
                saveClosureMutation={data.saveClosureMutation}
                handleSaveClosure={data.handleSaveClosure}
                resetClosureForm={data.resetClosureForm}
                onClose={() => data.setIsClosureModalOpen(false)}
            />

            <EditReasonDrawer
                isOpen={data.isReasonDrawerOpen}
                onClose={data.closeReasonDrawer}
                reasonDrawerData={data.reasonDrawerData}
                setReasonDrawerData={data.setReasonDrawerData}
                handleSaveReasonFromDrawer={data.handleSaveReasonFromDrawer}
                updateClosureReasonMutation={data.updateClosureReasonMutation}
            />

            <EditNoticeTypeDrawer
                isOpen={data.isNoticeTypeDrawerOpen}
                onClose={data.closeNoticeTypeDrawer}
                noticeTypeDrawerData={data.noticeTypeDrawerData}
                setNoticeTypeDrawerData={data.setNoticeTypeDrawerData}
                handleSaveNoticeTypeFromDrawer={data.handleSaveNoticeTypeFromDrawer}
                updateNoticeTypeMutation={data.updateNoticeTypeMutation}
            />

            <FloatingActionButton
                icon="add"
                label="New Notice"
                onClick={data.openNewClosure}
                extended
                text="New Notice"
            />
            </>
            )}
            </div>
            </TabTransition>
            <data.ConfirmDialogComponent />
        </AnimatedPage>
    );
};

export default BlocksTab;

import React from 'react';
import { SlideUpDrawer } from '../../../../components/SlideUpDrawer';
import type { NoticeType, ClosureReason } from './blocksTabTypes';

interface ClosureReasonsSectionProps {
    closureReasons: ClosureReason[];
    newReasonLabel: string;
    setNewReasonLabel: (value: string) => void;
    handleAddClosureReason: () => void;
    addClosureReasonMutation: { isPending: boolean };
    openReasonDrawer: (reason: ClosureReason) => void;
    handleDeleteClosureReason: (id: number) => void;
    handleReactivateClosureReason: (id: number) => void;
}

export const ClosureReasonsSection: React.FC<ClosureReasonsSectionProps> = ({
    closureReasons,
    newReasonLabel,
    setNewReasonLabel,
    handleAddClosureReason,
    addClosureReasonMutation,
    openReasonDrawer,
    handleDeleteClosureReason,
    handleReactivateClosureReason,
}) => (
    <div className="bg-white/60 dark:bg-white/5 backdrop-blur-sm border border-white/80 dark:border-white/10 rounded-xl p-4 mb-4">
        <div className="space-y-4">
            <p className="text-xs text-gray-500 dark:text-white/60">
                Manage the dropdown options shown when creating closures. Lower sort order appears first.
            </p>

            <div className="flex flex-col sm:flex-row gap-2">
                <input
                    type="text"
                    value={newReasonLabel}
                    onChange={(e) => setNewReasonLabel(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddClosureReason()}
                    placeholder="Add new reason..."
                    className="flex-1 px-3 py-2 rounded-xl bg-gray-100 dark:bg-white/10 border border-gray-300 dark:border-white/20 text-primary dark:text-white text-sm placeholder:text-gray-400 dark:placeholder:text-white/40 focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
                />
                <button
                    onClick={handleAddClosureReason}
                    disabled={!newReasonLabel.trim() || addClosureReasonMutation.isPending}
                    className="tactile-btn px-4 py-2 rounded-xl bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-fast flex items-center justify-center gap-1.5"
                >
                    <span aria-hidden="true" className="material-symbols-outlined text-base">add</span>
                    Add
                </button>
            </div>

            <div className="space-y-2">
                {closureReasons.filter(r => r.isActive).map((reason) => (
                    <div
                        key={reason.id}
                        className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-white/5 rounded-xl border border-gray-200 dark:border-white/10"
                    >
                        <span className="w-8 text-center text-xs text-gray-400 dark:text-white/40 tabular-nums">{reason.sortOrder}</span>
                        <span className="flex-1 text-sm text-primary dark:text-white font-medium truncate">{reason.label}</span>
                        <div className="flex gap-2 flex-shrink-0">
                            <button
                                onClick={() => openReasonDrawer(reason)}
                                className="tactile-btn p-1.5 rounded-lg bg-gray-200 dark:bg-white/20 text-gray-600 dark:text-white/70 hover:bg-gray-300 dark:hover:bg-white/30 transition-colors"
                                title="Edit"
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-base">edit</span>
                            </button>
                            <button
                                onClick={() => handleDeleteClosureReason(reason.id)}
                                className="tactile-btn p-1.5 rounded-lg bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-500/30 transition-colors"
                                title="Delete"
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-base">delete</span>
                            </button>
                        </div>
                    </div>
                ))}
            </div>

            {closureReasons.filter(r => !r.isActive).length > 0 && (
                <div className="pt-4 border-t border-gray-200 dark:border-white/20">
                    <p className="text-xs text-gray-500 dark:text-white/60 mb-2">Inactive Reasons</p>
                    <div className="space-y-2">
                        {closureReasons.filter(r => !r.isActive).map((reason) => (
                            <div
                                key={reason.id}
                                className="flex items-center gap-2 p-3 bg-gray-100 dark:bg-white/5 rounded-xl border border-gray-200 dark:border-white/10 opacity-60"
                            >
                                <span className="flex-1 text-sm text-gray-500 dark:text-white/50 line-through">{reason.label}</span>
                                <button
                                    onClick={() => handleReactivateClosureReason(reason.id)}
                                    className="tactile-btn px-3 py-1.5 rounded-lg bg-green-100 dark:bg-green-500/20 text-green-600 dark:text-green-400 text-xs font-medium hover:bg-green-200 dark:hover:bg-green-500/30 transition-colors"
                                >
                                    Reactivate
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    </div>
);

interface NoticeTypesSectionProps {
    noticeTypes: NoticeType[];
    newNoticeTypeName: string;
    setNewNoticeTypeName: (value: string) => void;
    handleAddNoticeType: () => void;
    addNoticeTypeMutation: { isPending: boolean };
    openNoticeTypeDrawer: (noticeType: NoticeType) => void;
    handleDeleteNoticeType: (id: number) => void;
}

export const NoticeTypesSection: React.FC<NoticeTypesSectionProps> = ({
    noticeTypes,
    newNoticeTypeName,
    setNewNoticeTypeName,
    handleAddNoticeType,
    addNoticeTypeMutation,
    openNoticeTypeDrawer,
    handleDeleteNoticeType,
}) => (
    <div className="bg-white/60 dark:bg-white/5 backdrop-blur-sm border border-white/80 dark:border-white/10 rounded-xl p-4 mb-4">
        <div className="space-y-4">
            <p className="text-xs text-gray-500 dark:text-white/60">
                Manage notice categories used when creating closures. Preset types cannot be edited or deleted.
            </p>

            <div className="flex flex-col sm:flex-row gap-2">
                <input
                    type="text"
                    value={newNoticeTypeName}
                    onChange={(e) => setNewNoticeTypeName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddNoticeType()}
                    placeholder="Add new notice type..."
                    className="flex-1 px-3 py-2 rounded-xl bg-gray-100 dark:bg-white/10 border border-gray-300 dark:border-white/20 text-primary dark:text-white text-sm placeholder:text-gray-400 dark:placeholder:text-white/40 focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
                />
                <button
                    onClick={handleAddNoticeType}
                    disabled={!newNoticeTypeName.trim() || addNoticeTypeMutation.isPending}
                    className="tactile-btn px-4 py-2 rounded-xl bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-fast flex items-center justify-center gap-1.5"
                >
                    <span aria-hidden="true" className="material-symbols-outlined text-base">add</span>
                    Add
                </button>
            </div>

            <div className="space-y-2">
                {noticeTypes.map((noticeType) => (
                    <div
                        key={noticeType.id}
                        className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-white/5 rounded-xl border border-gray-200 dark:border-white/10"
                    >
                        <span className="w-8 text-center text-xs text-gray-400 dark:text-white/40 tabular-nums">{noticeType.sortOrder}</span>
                        <span className="flex-1 text-sm text-primary dark:text-white font-medium truncate">{noticeType.name}</span>
                        {noticeType.isPreset && (
                            <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 flex-shrink-0">
                                Preset
                            </span>
                        )}
                        {!noticeType.isPreset && (
                            <div className="flex gap-2 flex-shrink-0">
                                <button
                                    onClick={() => openNoticeTypeDrawer(noticeType)}
                                    className="tactile-btn p-1.5 rounded-lg bg-gray-200 dark:bg-white/20 text-gray-600 dark:text-white/70 hover:bg-gray-300 dark:hover:bg-white/30 transition-colors"
                                    title="Edit"
                                >
                                    <span aria-hidden="true" className="material-symbols-outlined text-base">edit</span>
                                </button>
                                <button
                                    onClick={() => handleDeleteNoticeType(noticeType.id)}
                                    className="tactile-btn p-1.5 rounded-lg bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-500/30 transition-colors"
                                    title="Delete"
                                >
                                    <span aria-hidden="true" className="material-symbols-outlined text-base">delete</span>
                                </button>
                            </div>
                        )}
                    </div>
                ))}
                {noticeTypes.length === 0 && (
                    <p className="text-sm text-gray-500 dark:text-white/50 text-center py-4">
                        No notice types yet. Add one above or wait for preset types to be seeded.
                    </p>
                )}
            </div>
        </div>
    </div>
);

interface EditReasonDrawerProps {
    isOpen: boolean;
    onClose: () => void;
    reasonDrawerData: { id: number; label: string; sortOrder: number } | null;
    setReasonDrawerData: React.Dispatch<React.SetStateAction<{ id: number; label: string; sortOrder: number } | null>>;
    handleSaveReasonFromDrawer: () => void;
    updateClosureReasonMutation: { isPending: boolean };
}

export const EditReasonDrawer: React.FC<EditReasonDrawerProps> = ({
    isOpen,
    onClose,
    reasonDrawerData,
    setReasonDrawerData,
    handleSaveReasonFromDrawer,
    updateClosureReasonMutation,
}) => (
    <SlideUpDrawer
        isOpen={isOpen}
        onClose={onClose}
        title="Edit Closure Reason"
        maxHeight="small"
        stickyFooter={
            <div className="flex gap-3 p-4">
                <button
                    onClick={onClose}
                    className="flex-1 py-3 rounded-xl bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-white/70 font-medium hover:bg-gray-200 dark:hover:bg-white/20 transition-colors"
                >
                    Cancel
                </button>
                <button
                    onClick={handleSaveReasonFromDrawer}
                    disabled={!reasonDrawerData?.label?.trim() || updateClosureReasonMutation.isPending}
                    className="flex-1 py-3 rounded-xl font-medium text-white bg-primary hover:bg-primary/90 disabled:bg-primary/50 transition-colors"
                >
                    {updateClosureReasonMutation.isPending ? 'Saving...' : 'Save'}
                </button>
            </div>
        }
    >
        <div className="p-5 space-y-4">
            <div>
                <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Label *</label>
                <input
                    type="text"
                    value={reasonDrawerData?.label || ''}
                    onChange={(e) => setReasonDrawerData(prev => prev ? { ...prev, label: e.target.value } : null)}
                    placeholder="e.g., Private Event, Maintenance"
                    className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast"
                />
            </div>
            <div>
                <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Sort Order</label>
                <input
                    type="number"
                    value={reasonDrawerData?.sortOrder || 100}
                    onChange={(e) => setReasonDrawerData(prev => prev ? { ...prev, sortOrder: parseInt(e.target.value, 10) || 100 } : null)}
                    className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Lower numbers appear first in dropdown menus</p>
            </div>
        </div>
    </SlideUpDrawer>
);

interface EditNoticeTypeDrawerProps {
    isOpen: boolean;
    onClose: () => void;
    noticeTypeDrawerData: { id: number; name: string; sortOrder: number } | null;
    setNoticeTypeDrawerData: React.Dispatch<React.SetStateAction<{ id: number; name: string; sortOrder: number } | null>>;
    handleSaveNoticeTypeFromDrawer: () => void;
    updateNoticeTypeMutation: { isPending: boolean };
}

export const EditNoticeTypeDrawer: React.FC<EditNoticeTypeDrawerProps> = ({
    isOpen,
    onClose,
    noticeTypeDrawerData,
    setNoticeTypeDrawerData,
    handleSaveNoticeTypeFromDrawer,
    updateNoticeTypeMutation,
}) => (
    <SlideUpDrawer
        isOpen={isOpen}
        onClose={onClose}
        title="Edit Notice Type"
        maxHeight="small"
        stickyFooter={
            <div className="flex gap-3 p-4">
                <button
                    onClick={onClose}
                    className="flex-1 py-3 rounded-xl bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-white/70 font-medium hover:bg-gray-200 dark:hover:bg-white/20 transition-colors"
                >
                    Cancel
                </button>
                <button
                    onClick={handleSaveNoticeTypeFromDrawer}
                    disabled={!noticeTypeDrawerData?.name?.trim() || updateNoticeTypeMutation.isPending}
                    className="flex-1 py-3 rounded-xl font-medium text-white bg-primary hover:bg-primary/90 disabled:bg-primary/50 transition-colors"
                >
                    {updateNoticeTypeMutation.isPending ? 'Saving...' : 'Save'}
                </button>
            </div>
        }
    >
        <div className="p-5 space-y-4">
            <div>
                <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Name *</label>
                <input
                    type="text"
                    value={noticeTypeDrawerData?.name || ''}
                    onChange={(e) => setNoticeTypeDrawerData(prev => prev ? { ...prev, name: e.target.value } : null)}
                    placeholder="e.g., Maintenance, Holiday"
                    className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast"
                />
            </div>
            <div>
                <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Sort Order</label>
                <input
                    type="number"
                    value={noticeTypeDrawerData?.sortOrder || 100}
                    onChange={(e) => setNoticeTypeDrawerData(prev => prev ? { ...prev, sortOrder: parseInt(e.target.value, 10) || 100 } : null)}
                    className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Lower numbers appear first in dropdown menus</p>
            </div>
        </div>
    </SlideUpDrawer>
);

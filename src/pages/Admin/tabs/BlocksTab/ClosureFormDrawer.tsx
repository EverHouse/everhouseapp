import React from 'react';
import { SlideUpDrawer } from '../../../../components/SlideUpDrawer';
import type { BlocksClosureForm, NoticeType, ClosureReason } from './blocksTabTypes';

interface ClosureFormDrawerProps {
    isOpen: boolean;
    editingClosureId: number | null;
    closureForm: BlocksClosureForm;
    setClosureForm: React.Dispatch<React.SetStateAction<BlocksClosureForm>>;
    touchedFields: Set<string>;
    markTouched: (field: string) => void;
    closureValidation: { notice_type: boolean; affected_areas: boolean };
    isClosureFormValid: boolean;
    noticeTypes: NoticeType[];
    closureReasons: ClosureReason[];
    bays: { id: number; name: string; type: string }[];
    isBlocking: (areas: string | null) => boolean;
    formatAffectedAreas: (areas: string | null) => string;
    saveClosureMutation: { isPending: boolean };
    handleSaveClosure: () => void;
    resetClosureForm: () => void;
    onClose: () => void;
}

export const ClosureFormDrawer: React.FC<ClosureFormDrawerProps> = ({
    isOpen,
    editingClosureId,
    closureForm,
    setClosureForm,
    touchedFields,
    markTouched,
    closureValidation,
    isClosureFormValid,
    noticeTypes,
    closureReasons,
    bays,
    isBlocking,
    formatAffectedAreas,
    saveClosureMutation,
    handleSaveClosure,
    resetClosureForm,
    onClose,
}) => {
    const handleClose = () => {
        onClose();
        resetClosureForm();
    };

    return (
        <SlideUpDrawer
            isOpen={isOpen}
            onClose={handleClose}
            title={editingClosureId ? 'Edit Notice' : 'New Notice'}
            maxHeight="large"
            stickyFooter={
                <div className="flex gap-3 p-4">
                    <button
                        onClick={handleClose}
                        className="flex-1 py-3 rounded-xl bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-white/70 font-medium hover:bg-gray-200 dark:hover:bg-white/20 transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSaveClosure}
                        disabled={!closureForm.start_date || saveClosureMutation.isPending || !isClosureFormValid}
                        className={`flex-1 py-3 rounded-xl font-medium text-white transition-colors ${
                            isBlocking(closureForm.affected_areas)
                                ? 'bg-red-500 hover:bg-red-600 disabled:bg-red-300'
                                : 'bg-amber-500 hover:bg-amber-600 disabled:bg-amber-300'
                        }`}
                    >
                        {saveClosureMutation.isPending ? 'Saving...' : editingClosureId ? 'Update' : 'Create'}
                    </button>
                </div>
            }
        >
            <div className="p-5 space-y-4">
                <div className="space-y-3">
                    <div>
                        <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Reason Category *</label>
                        <select
                            value={closureForm.notice_type}
                            onChange={e => setClosureForm({...closureForm, notice_type: e.target.value})}
                            onBlur={() => markTouched('notice_type')}
                            className={`w-full border bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast ${
                                touchedFields.has('notice_type') && closureValidation.notice_type
                                    ? 'border-red-500 dark:border-red-500'
                                    : 'border-gray-200 dark:border-white/20'
                            }`}
                        >
                            <option value="">Select category...</option>
                            {noticeTypes.map(type => (
                                <option key={type.id} value={type.name}>{type.name}</option>
                            ))}
                        </select>
                        {touchedFields.has('notice_type') && closureValidation.notice_type && (
                            <p className="text-xs text-red-500 mt-1">Reason category is required</p>
                        )}
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                            Syncs with Google Calendar bracket prefix
                        </p>
                    </div>
                    <div>
                        <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Title <span className="text-[9px] font-normal normal-case text-gray-400 dark:text-gray-500">(internal only)</span></label>
                        <input
                            type="text"
                            placeholder="e.g., Holiday Closure, Maintenance"
                            className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast"
                            value={closureForm.title}
                            onChange={e => setClosureForm({...closureForm, title: e.target.value})}
                        />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Closure Reason</label>
                        <select
                            value={closureForm.reason}
                            onChange={e => setClosureForm({...closureForm, reason: e.target.value})}
                            className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast"
                        >
                            <option value="">Select reason...</option>
                            {closureReasons.filter(r => r.isActive).map(reason => (
                                <option key={reason.id} value={reason.label}>{reason.label}</option>
                            ))}
                        </select>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                            Shown as a badge to members. Manage options in "Closure Reasons" section above.
                        </p>
                    </div>
                    <div>
                        <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Notes</label>
                        <textarea
                            className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast resize-none"
                            placeholder="Internal notes, event details, logistics..."
                            rows={3}
                            value={closureForm.notes}
                            onChange={e => setClosureForm({...closureForm, notes: e.target.value})}
                        />
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                            Syncs with Google Calendar event description
                        </p>
                    </div>
                    <div>
                        <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-2 block">Affected Resources *</label>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500"></span> Selecting resources will block bookings (red card)</span>
                            <br />
                            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500"></span> "None" is for announcements only (amber card)</span>
                        </p>
                        <div className="space-y-2 p-3 bg-gray-50 dark:bg-black/20 rounded-xl border border-gray-200 dark:border-white/25">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={closureForm.affected_areas === 'none' || closureForm.affected_areas === ''}
                                    onChange={(e) => {
                                        if (e.target.checked) {
                                            setClosureForm({...closureForm, affected_areas: 'none'});
                                        }
                                    }}
                                    className="w-4 h-4 rounded border-gray-300 text-amber-500 focus:ring-amber-500"
                                />
                                <span className="text-sm text-primary dark:text-white">None (informational only)</span>
                            </label>
                            <div className="border-t border-gray-200 dark:border-white/25 my-2"></div>
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={closureForm.affected_areas === 'entire_facility'}
                                    onChange={(e) => {
                                        if (e.target.checked) {
                                            setClosureForm({...closureForm, affected_areas: 'entire_facility'});
                                        } else {
                                            setClosureForm({...closureForm, affected_areas: 'none'});
                                        }
                                    }}
                                    className="w-4 h-4 rounded border-gray-300 text-red-500 focus:ring-red-500"
                                />
                                <span className="text-sm text-primary dark:text-white font-medium">Entire Facility</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={closureForm.affected_areas.split(',').some(a => a.trim() === 'conference_room')}
                                    onChange={(e) => {
                                        const currentSet = new Set(closureForm.affected_areas.split(',').map(a => a.trim()).filter(a => a && a !== 'none' && a !== 'entire_facility'));
                                        if (e.target.checked) {
                                            currentSet.add('conference_room');
                                        } else {
                                            currentSet.delete('conference_room');
                                        }
                                        setClosureForm({...closureForm, affected_areas: currentSet.size > 0 ? Array.from(currentSet).join(',') : 'none'});
                                    }}
                                    className="w-4 h-4 rounded border-gray-300 text-red-500 focus:ring-red-500"
                                />
                                <span className="text-sm text-primary dark:text-white">Conference Room</span>
                            </label>
                            {bays.map(bay => (
                                <label key={bay.id} className="flex items-center gap-2 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={closureForm.affected_areas.split(',').some(a => a.trim() === `bay_${bay.id}`)}
                                        onChange={(e) => {
                                            const currentSet = new Set(closureForm.affected_areas.split(',').map(a => a.trim()).filter(a => a && a !== 'none' && a !== 'entire_facility'));
                                            if (e.target.checked) {
                                                currentSet.add(`bay_${bay.id}`);
                                            } else {
                                                currentSet.delete(`bay_${bay.id}`);
                                            }
                                            setClosureForm({...closureForm, affected_areas: currentSet.size > 0 ? Array.from(currentSet).join(',') : 'none'});
                                        }}
                                        className="w-4 h-4 rounded border-gray-300 text-red-500 focus:ring-red-500"
                                    />
                                    <span className="text-sm text-primary dark:text-white">{bay.name}</span>
                                </label>
                            ))}
                        </div>
                        {closureForm.affected_areas && closureForm.affected_areas !== 'none' && closureForm.affected_areas !== 'entire_facility' && (
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                Selected: {formatAffectedAreas(closureForm.affected_areas)}
                            </p>
                        )}
                    </div>
                    <div>
                        <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-2 block">Member Visibility</label>
                        <div className="p-3 bg-gray-50 dark:bg-black/20 rounded-xl border border-gray-200 dark:border-white/25">
                            <label className={`flex items-center gap-3 ${closureForm.affected_areas !== 'none' ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}>
                                <input
                                    type="checkbox"
                                    checked={closureForm.affected_areas !== 'none' || closureForm.notify_members}
                                    disabled={closureForm.affected_areas !== 'none'}
                                    onChange={(e) => {
                                        if (closureForm.affected_areas === 'none') {
                                            setClosureForm({...closureForm, notify_members: e.target.checked});
                                        }
                                    }}
                                    className="w-5 h-5 rounded border-gray-300 text-primary focus:ring-primary disabled:opacity-50"
                                />
                                <div>
                                    <span className="text-sm font-medium text-primary dark:text-white">Show to Members</span>
                                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                        {closureForm.affected_areas !== 'none'
                                            ? 'Always shown when bookings are affected'
                                            : 'Display this notice on member dashboard and updates'}
                                    </p>
                                </div>
                            </label>
                        </div>
                    </div>
                    <div>
                        <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Start Date *</label>
                        <input
                            type="date"
                            className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast"
                            value={closureForm.start_date}
                            onChange={e => setClosureForm({...closureForm, start_date: e.target.value})}
                        />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Start Time</label>
                        <input
                            type="time"
                            className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast"
                            value={closureForm.start_time}
                            onChange={e => setClosureForm({...closureForm, start_time: e.target.value})}
                        />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">End Date</label>
                        <input
                            type="date"
                            className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast"
                            value={closureForm.end_date}
                            onChange={e => setClosureForm({...closureForm, end_date: e.target.value})}
                        />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">End Time</label>
                        <input
                            type="time"
                            className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast"
                            value={closureForm.end_time}
                            onChange={e => setClosureForm({...closureForm, end_time: e.target.value})}
                        />
                    </div>
                </div>
            </div>
        </SlideUpDrawer>
    );
};

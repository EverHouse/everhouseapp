import React from 'react';
import { formatTitleForDisplay } from '../../../../utils/closureUtils';
import type { BlocksClosure } from './blocksTabTypes';
import { stripHtml } from './blocksTabTypes';
import Icon from '../../../../components/icons/Icon';

interface NoticeListProps {
    configuredClosures: BlocksClosure[];
    pastClosures: BlocksClosure[];
    closuresLoading: boolean;
    closuresCount: number;
    expandedNotices: Set<number>;
    showPastAccordion: boolean;
    pastNoticesLimit: number;
    isBlocking: (areas: string | null) => boolean;
    formatDate: (dateStr: string) => string;
    formatTime: (time: string) => string;
    formatAffectedAreas: (areas: string | null) => string;
    getAffectedAreasList: (areas: string | null) => string[];
    getMissingFields: (closure: BlocksClosure) => string[];
    toggleNoticeExpand: (closureId: number) => void;
    handleEditClosure: (closure: BlocksClosure, e?: React.MouseEvent) => void;
    handleDeleteClosure: (closureId: number, e?: React.MouseEvent) => void;
    setShowPastAccordion: (show: boolean) => void;
    setPastNoticesLimit: React.Dispatch<React.SetStateAction<number>>;
}

export const NoticeList: React.FC<NoticeListProps> = ({
    configuredClosures,
    pastClosures,
    closuresLoading,
    closuresCount,
    expandedNotices,
    showPastAccordion,
    pastNoticesLimit,
    isBlocking,
    formatDate,
    formatTime,
    formatAffectedAreas,
    getAffectedAreasList,
    getMissingFields,
    toggleNoticeExpand,
    handleEditClosure,
    handleDeleteClosure,
    setShowPastAccordion,
    setPastNoticesLimit,
}) => {
    if (closuresLoading) {
        return <div className="text-center py-8 text-gray-600 dark:text-white/70">Loading notices...</div>;
    }

    if (configuredClosures.length === 0) {
        return (
            <div className="text-center py-12 text-gray-600 dark:text-white/70">
                <Icon name="event_available" className="text-4xl mb-2" />
                <p>{closuresCount === 0 ? 'No notices' : 'No notices match filters'}</p>
            </div>
        );
    }

    return (
        <>
            {configuredClosures.length > 0 && (
                <div className="space-y-3">
                    {configuredClosures.map((closure, index) => {
                        const missingFields = getMissingFields(closure);
                        const isIncomplete = missingFields.length > 0;
                        const blocking = !isIncomplete && isBlocking(closure.affectedAreas);
                        const isExpanded = expandedNotices.has(closure.id);

                        return (
                            <div
                                key={closure.id}
                                className={`bg-white/60 dark:bg-white/5 backdrop-blur-sm border border-white/80 dark:border-white/10 rounded-xl shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-colors duration-fast overflow-hidden group tactile-card ${index < 10 ? `animate-list-item-delay-${index}` : 'animate-list-item'} ${
                                    isIncomplete
                                        ? 'border-l-4 border-l-blue-500'
                                        : blocking
                                            ? 'border-l-4 border-l-red-500'
                                            : 'border-l-4 border-l-amber-500'
                                }`}
                            >
                                <div className="w-full p-4 text-left">
                                    <div className="flex items-start justify-between gap-3">
                                        <div
                                            className="flex-1 min-w-0 cursor-pointer"
                                            onClick={() => toggleNoticeExpand(closure.id)}
                                        >
                                            <div className="flex flex-wrap items-center gap-1.5 mb-1">
                                                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isIncomplete ? 'bg-blue-500' : blocking ? 'bg-red-500' : 'bg-amber-500'}`}></span>
                                                {isIncomplete ? (
                                                    <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-blue-200 dark:bg-blue-500/30 text-blue-700 dark:text-blue-300">
                                                        Draft
                                                    </span>
                                                ) : (
                                                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                                                    blocking
                                                        ? 'bg-red-200 dark:bg-red-500/30 text-red-700 dark:text-red-300'
                                                        : 'bg-amber-200 dark:bg-amber-500/30 text-amber-700 dark:text-amber-300'
                                                }`}>
                                                    {blocking
                                                        ? formatTitleForDisplay(closure.noticeType || 'Closure')
                                                        : (closure.noticeType && closure.noticeType.toLowerCase() !== 'closure' ? formatTitleForDisplay(closure.noticeType) : 'Notice')
                                                    }
                                                </span>
                                                )}
                                                {closure.reason && closure.reason.trim() && (
                                                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                                                        isIncomplete
                                                            ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400'
                                                            : blocking
                                                                ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                                                                : 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                                                    }`}>
                                                        {closure.reason}
                                                    </span>
                                                )}
                                            </div>
                                            <h4 className="font-bold text-primary dark:text-white mb-1 truncate">{closure.title.replace(/^\[[^\]]+\]\s*:?\s*/i, '')}</h4>
                                            {closure.notes && (
                                                <p className="text-sm text-gray-600 dark:text-white/70 mb-2 line-clamp-2">{stripHtml(closure.notes)}</p>
                                            )}
                                            <div className="flex flex-wrap gap-2">
                                                <div className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs ${
                                                    isIncomplete
                                                        ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400'
                                                        : blocking
                                                            ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                                                            : 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                                                }`}>
                                                    <Icon name="calendar_today" className="text-[12px]" />
                                                    <span>
                                                        {formatDate(closure.startDate)}
                                                        {closure.endDate && closure.endDate !== closure.startDate ? ` - ${formatDate(closure.endDate)}` : ''}
                                                    </span>
                                                </div>
                                                {isIncomplete && (
                                                    <div className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400">
                                                        <Icon name="warning" className="text-[12px]" />
                                                        <span>Missing: {missingFields.join(', ')}</span>
                                                    </div>
                                                )}
                                                {(closure.startTime || closure.endTime) && (
                                                    <div className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs ${
                                                        isIncomplete
                                                            ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400'
                                                            : blocking
                                                                ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                                                                : 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                                                    }`}>
                                                        <Icon name="schedule" className="text-[12px]" />
                                                        <span>
                                                            {closure.startTime ? formatTime(closure.startTime) : 'All day'}
                                                            {closure.endTime ? ` - ${formatTime(closure.endTime)}` : ''}
                                                        </span>
                                                    </div>
                                                )}
                                                <div className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs ${
                                                    isIncomplete
                                                        ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400'
                                                        : blocking
                                                            ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                                                            : 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                                                }`}>
                                                    <Icon name="location_on" className="text-[12px]" />
                                                    <span>{formatAffectedAreas(closure.affectedAreas)}</span>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1 flex-shrink-0">
                                            <button
                                                onClick={(e) => handleEditClosure(closure, e)}
                                                className={`p-2 rounded-xl transition-all opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-fast ${
                                                    isIncomplete
                                                        ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-500/30'
                                                        : blocking
                                                            ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-500/30'
                                                            : 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-500/30'
                                                }`}
                                            >
                                                <Icon name="edit" className="text-base" />
                                            </button>
                                            <button
                                                onClick={() => toggleNoticeExpand(closure.id)}
                                                className="p-1"
                                            >
                                                <Icon name="expand_more" className={`text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {isExpanded && (
                                    <div className="bg-gray-50/50 dark:bg-white/5 border-t border-gray-200/50 dark:border-white/10 p-4 space-y-3">
                                        {closure.memberNotice && (
                                            <div className="bg-white/60 dark:bg-white/5 rounded-lg p-3 text-sm text-gray-600 dark:text-white/70">
                                                <p className="text-[10px] font-bold uppercase text-gray-400 dark:text-white/40 mb-1">Member Notice</p>
                                                {closure.memberNotice}
                                            </div>
                                        )}

                                        {closure.affectedAreas && closure.affectedAreas !== 'none' && (
                                            <div>
                                                <p className="text-[10px] font-bold uppercase text-gray-400 dark:text-white/40 mb-2">Affected Resources</p>
                                                <div className="flex flex-wrap gap-1.5">
                                                    {getAffectedAreasList(closure.affectedAreas).map((area, i) => (
                                                        <div key={i} className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs ${
                                                            blocking
                                                                ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                                                                : 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                                                        }`}>
                                                            <Icon name={area.toLowerCase().includes('conference') ? 'meeting_room' : 'sports_golf'} className="text-[12px]" />
                                                            <span>{area}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        <div className="flex gap-2 pt-2">
                                            <button
                                                onClick={(e) => handleEditClosure(closure, e)}
                                                className={`flex-1 py-2 px-4 rounded-xl font-medium transition-all duration-fast ${
                                                    blocking
                                                        ? 'bg-red-500 text-white hover:bg-red-600'
                                                        : 'bg-amber-500 text-white hover:bg-amber-600'
                                                }`}
                                            >
                                                Edit Notice
                                            </button>
                                            <button
                                                onClick={(e) => handleDeleteClosure(closure.id, e)}
                                                className="py-2 px-4 rounded-xl bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-white/70 hover:bg-gray-200 dark:hover:bg-white/20 transition-all duration-fast"
                                            >
                                                Delete
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {pastClosures.length > 0 && (
                <div className="mt-6 accordion-item-wrapper bg-white/60 dark:bg-white/5 backdrop-blur-sm border border-white/80 dark:border-white/10 rounded-xl overflow-hidden">
                    <button
                        onClick={() => setShowPastAccordion(!showPastAccordion)}
                        className="w-full flex items-center justify-between p-4 hover:bg-gray-50/50 dark:hover:bg-white/5 transition-colors"
                    >
                        <div className="flex items-center gap-2">
                            <Icon name="history" className="text-gray-500 dark:text-white/60" />
                            <span className="font-semibold text-gray-600 dark:text-white/80">Past Notices</span>
                            <span className="text-xs bg-gray-200 dark:bg-white/20 text-gray-600 dark:text-white/70 px-2 py-0.5 rounded-[4px]">
                                {pastClosures.length}
                            </span>
                        </div>
                        <Icon name="expand_more" className={`text-gray-400 transition-transform ${showPastAccordion ? 'rotate-180' : ''}`} />
                    </button>

                    <div className={`accordion-content ${showPastAccordion ? 'is-open' : ''}`}>
                      <div className="accordion-inner">
                        <div className="p-4 space-y-3 bg-gray-50/50 dark:bg-white/5 border-t border-gray-200/50 dark:border-white/10">
                            {pastClosures.slice(0, pastNoticesLimit).map((closure, _index) => {
                                const blocking = isBlocking(closure.affectedAreas);
                                const isExpanded = expandedNotices.has(closure.id);

                                return (
                                    <div
                                        key={closure.id}
                                        className={`bg-white/60 dark:bg-white/5 backdrop-blur-sm border border-white/80 dark:border-white/10 rounded-xl overflow-hidden transition-all duration-fast opacity-70 hover:opacity-100 hover:shadow-sm group ${
                                            blocking
                                                ? 'border-l-4 border-l-red-500'
                                                : 'border-l-4 border-l-amber-500'
                                        }`}
                                    >
                                        <div className="p-3">
                                            <div className="flex items-start justify-between gap-2">
                                                <div
                                                    className="flex-1 min-w-0 cursor-pointer"
                                                    onClick={() => toggleNoticeExpand(closure.id)}
                                                >
                                                    <div className="flex flex-wrap items-center gap-1.5 mb-1">
                                                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${blocking ? 'bg-red-400' : 'bg-amber-400'}`}></span>
                                                        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                                                            blocking
                                                                ? 'bg-red-200/60 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                                                                : 'bg-amber-200/60 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                                                        }`}>
                                                            {blocking
                                                                ? formatTitleForDisplay(closure.noticeType || 'Closure')
                                                                : (closure.noticeType && closure.noticeType.toLowerCase() !== 'closure' ? formatTitleForDisplay(closure.noticeType) : 'Notice')
                                                            }
                                                        </span>
                                                    </div>
                                                    <h4 className="font-medium text-sm text-gray-600 dark:text-white/70 mb-1 truncate">{closure.title.replace(/^\[[^\]]+\]\s*:?\s*/i, '')}</h4>
                                                    {closure.notes && (
                                                        <p className="text-xs text-gray-500 dark:text-white/50 mb-1 line-clamp-1">{stripHtml(closure.notes)}</p>
                                                    )}
                                                    <div className="flex flex-wrap gap-1.5">
                                                        <div className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs ${
                                                            blocking
                                                                ? 'bg-red-100/60 dark:bg-red-500/15 text-red-500 dark:text-red-400'
                                                                : 'bg-amber-100/60 dark:bg-amber-500/15 text-amber-500 dark:text-amber-400'
                                                        }`}>
                                                            <Icon name="calendar_today" className="text-[11px]" />
                                                            <span>
                                                                {formatDate(closure.startDate)}
                                                                {closure.endDate && closure.endDate !== closure.startDate ? ` - ${formatDate(closure.endDate)}` : ''}
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-1 flex-shrink-0">
                                                    <button
                                                        onClick={(e) => handleEditClosure(closure, e)}
                                                        className="p-1.5 rounded-lg bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/50 hover:bg-gray-200 dark:hover:bg-white/20 transition-all opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-fast"
                                                    >
                                                        <Icon name="edit" className="text-base" />
                                                    </button>
                                                    <button
                                                        onClick={() => toggleNoticeExpand(closure.id)}
                                                        className="p-1"
                                                    >
                                                        <Icon name="expand_more" className={`text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                                    </button>
                                                </div>
                                            </div>
                                        </div>

                                        {isExpanded && (
                                            <div className="bg-gray-50/50 dark:bg-white/5 border-t border-gray-200/50 dark:border-white/10 p-3">
                                                <div className="flex gap-2">
                                                    <button
                                                        onClick={(e) => handleEditClosure(closure, e)}
                                                        className="flex-1 py-2 px-3 rounded-lg bg-gray-200 dark:bg-white/10 text-gray-600 dark:text-white/70 text-sm font-medium hover:bg-gray-300 dark:hover:bg-white/20 transition-all duration-fast"
                                                    >
                                                        Edit
                                                    </button>
                                                    <button
                                                        onClick={(e) => handleDeleteClosure(closure.id, e)}
                                                        className="py-2 px-3 rounded-lg bg-gray-100 dark:bg-white/5 text-gray-500 dark:text-white/50 text-sm hover:bg-gray-200 dark:hover:bg-white/10 transition-all duration-fast"
                                                    >
                                                        Delete
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                            {pastClosures.length > pastNoticesLimit && (
                                <button
                                    onClick={() => setPastNoticesLimit(prev => prev + 50)}
                                    className="w-full py-3 text-sm font-medium text-gray-500 dark:text-white/60 hover:text-gray-700 dark:hover:text-white/80 bg-white/40 dark:bg-white/5 rounded-xl hover:bg-white/60 dark:hover:bg-white/10 transition-colors"
                                >
                                    Show more ({pastClosures.length - pastNoticesLimit} remaining)
                                </button>
                            )}
                        </div>
                      </div>
                    </div>
                </div>
            )}
        </>
    );
};

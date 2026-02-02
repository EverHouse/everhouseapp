import React, { useState, useEffect } from 'react';
import { usePageReady } from '../../contexts/PageReadyContext';
import EmptyState from '../../components/EmptyState';
import { useTheme } from '../../contexts/ThemeContext';
import ModalShell from '../../components/ModalShell';
import { getBugReportStatusColor, formatStatusLabel, getRoleColor } from '../../utils/statusColors';
import { formatRelativeTime, formatCardTimestamp } from '../../utils/dateUtils';
import { useConfirmDialog } from '../../components/ConfirmDialog';

interface BugReport {
    id: number;
    userEmail: string;
    userName: string | null;
    userRole: string | null;
    description: string;
    screenshotUrl: string | null;
    pageUrl: string | null;
    userAgent: string | null;
    status: string;
    resolvedBy: string | null;
    resolvedAt: string | null;
    staffNotes: string | null;
    createdAt: string;
    updatedAt: string | null;
}

const STATUS_TABS = [
    { id: 'all', label: 'All', icon: 'inbox' },
    { id: 'open', label: 'Open', icon: 'error_outline' },
    { id: 'in_progress', label: 'In Progress', icon: 'pending' },
    { id: 'resolved', label: 'Resolved', icon: 'check_circle' },
];

const BugReportsAdmin: React.FC = () => {
    const { setPageReady } = usePageReady();
    const { effectiveTheme } = useTheme();
    const isDark = effectiveTheme === 'dark';
    const [reports, setReports] = useState<BugReport[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [activeStatus, setActiveStatus] = useState('open');
    const [selectedReport, setSelectedReport] = useState<BugReport | null>(null);
    const [isDetailOpen, setIsDetailOpen] = useState(false);
    const [staffNotes, setStaffNotes] = useState('');
    const [isSaving, setIsSaving] = useState(false);
    const { confirm, ConfirmDialogComponent } = useConfirmDialog();

    useEffect(() => {
        window.scrollTo(0, 0);
    }, []);

    useEffect(() => {
        if (!isLoading) {
            setPageReady(true);
        }
    }, [isLoading, setPageReady]);

    const fetchReports = async () => {
        try {
            const params = new URLSearchParams();
            if (activeStatus !== 'all') params.append('status', activeStatus);
            
            const res = await fetch(`/api/admin/bug-reports?${params.toString()}`, { credentials: 'include' });
            if (res.ok) {
                const data = await res.json();
                setReports(data);
            }
        } catch (err) {
            console.error('Failed to fetch bug reports:', err);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        setIsLoading(true);
        fetchReports();
    }, [activeStatus]);

    const openDetail = (report: BugReport) => {
        setSelectedReport(report);
        setStaffNotes(report.staffNotes || '');
        setIsDetailOpen(true);
    };

    const handleUpdateStatus = async (status: string) => {
        if (!selectedReport) return;
        setIsSaving(true);
        try {
            const res = await fetch(`/api/admin/bug-reports/${selectedReport.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ status }),
            });
            if (res.ok) {
                const updated = await res.json();
                setReports(prev => prev.map(r => r.id === selectedReport.id ? updated : r));
                setSelectedReport(updated);
            }
        } catch (err) {
            console.error('Failed to update status:', err);
        } finally {
            setIsSaving(false);
        }
    };

    const handleSaveNotes = async () => {
        if (!selectedReport) return;
        setIsSaving(true);
        try {
            const res = await fetch(`/api/admin/bug-reports/${selectedReport.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ staffNotes }),
            });
            if (res.ok) {
                const updated = await res.json();
                setReports(prev => prev.map(r => r.id === selectedReport.id ? updated : r));
                setSelectedReport(updated);
            }
        } catch (err) {
            console.error('Failed to save notes:', err);
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!selectedReport) return;
        const confirmed = await confirm({
            title: 'Delete Bug Report',
            message: 'Are you sure you want to delete this bug report?',
            confirmText: 'Delete',
            variant: 'danger'
        });
        if (!confirmed) return;
        
        setIsSaving(true);
        try {
            const res = await fetch(`/api/admin/bug-reports/${selectedReport.id}`, {
                method: 'DELETE',
                credentials: 'include',
            });
            if (res.ok) {
                setReports(prev => prev.filter(r => r.id !== selectedReport.id));
                setIsDetailOpen(false);
                setSelectedReport(null);
            }
        } catch (err) {
            console.error('Failed to delete:', err);
        } finally {
            setIsSaving(false);
        }
    };


    const openCount = reports.filter(r => r.status === 'open').length;

    return (
        <div className="min-h-screen pb-32">
            <div className="px-4 pt-6">
                <div className="flex items-center justify-between mb-6 animate-slide-up-stagger" style={{ '--stagger-index': 0 } as React.CSSProperties}>
                    <div>
                        <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-primary'}`}>Bug Reports</h1>
                        <p className={`text-sm mt-1 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                            {openCount} open {openCount === 1 ? 'report' : 'reports'}
                        </p>
                    </div>
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${isDark ? 'glass-button' : 'bg-white border border-black/10'}`}>
                        <span className={`material-symbols-outlined ${isDark ? 'text-white' : 'text-primary'}`} aria-hidden="true">bug_report</span>
                    </div>
                </div>

                <div className="flex gap-2 overflow-x-auto pb-2 mb-6 scrollbar-hide animate-slide-up-stagger scroll-fade-right" style={{ '--stagger-index': 1 } as React.CSSProperties}>
                    {STATUS_TABS.map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveStatus(tab.id)}
                            className={`flex items-center gap-1.5 px-3 py-2 min-h-[44px] rounded-full text-xs font-medium whitespace-nowrap transition-all flex-shrink-0 ${
                                activeStatus === tab.id
                                    ? isDark ? 'bg-accent text-primary' : 'bg-primary text-white'
                                    : isDark ? 'glass-button text-white/80' : 'bg-white border border-black/10 text-primary/80'
                            }`}
                        >
                            <span className="material-symbols-outlined text-sm" aria-hidden="true">{tab.icon}</span>
                            {tab.label}
                        </button>
                    ))}
                </div>

                {isLoading ? (
                    <div className="space-y-3">
                        {[1, 2, 3].map(i => (
                            <div key={i} className={`h-24 rounded-2xl animate-pulse ${isDark ? 'bg-white/5' : 'bg-black/5'}`} />
                        ))}
                    </div>
                ) : reports.length === 0 ? (
                    <EmptyState
                        icon="bug_report"
                        title="No bug reports found"
                        description="Bug reports submitted by users will appear here"
                        variant="compact"
                    />
                ) : (
                    <div className="space-y-3">
                        {reports.map((report, idx) => (
                            <button
                                key={report.id}
                                onClick={() => openDetail(report)}
                                className={`w-full text-left p-4 rounded-2xl transition-all animate-slide-up-stagger ${isDark ? 'glass-card hover:bg-white/5' : 'bg-white border border-black/5 hover:shadow-md'}`}
                                style={{ '--stagger-index': idx } as React.CSSProperties}
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className={`text-sm font-semibold truncate ${isDark ? 'text-white' : 'text-primary'}`}>
                                                {report.userName || report.userEmail}
                                            </span>
                                            <span className={`px-2 py-0.5 text-[10px] font-bold uppercase rounded-full ${getRoleColor(report.userRole)}`}>
                                                {report.userRole || 'member'}
                                            </span>
                                        </div>
                                        <p className={`text-sm line-clamp-2 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                                            {report.description}
                                        </p>
                                        <div className="flex items-center gap-2 mt-3">
                                            <span className={`px-2 py-0.5 text-[10px] font-bold uppercase rounded-full ${getBugReportStatusColor(report.status)}`}>
                                                {formatStatusLabel(report.status)}
                                            </span>
                                            <span className={`text-xs ${isDark ? 'text-white/50' : 'text-primary/50'}`}>
                                                {formatRelativeTime(report.createdAt)}
                                            </span>
                                            {report.screenshotUrl && (
                                                <span className={`material-symbols-outlined text-sm ${isDark ? 'text-white/50' : 'text-primary/50'}`} aria-hidden="true">image</span>
                                            )}
                                        </div>
                                    </div>
                                    <span className={`material-symbols-outlined text-sm ${isDark ? 'text-white/70' : 'text-primary/70'}`} aria-hidden="true">chevron_right</span>
                                </div>
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <ModalShell 
                isOpen={isDetailOpen && selectedReport !== null} 
                onClose={() => setIsDetailOpen(false)} 
                title={selectedReport ? `Bug Report #${selectedReport.id}` : 'Bug Report'}
                size="lg"
            >
                {selectedReport && (
                    <div className="p-4 space-y-4">
                        <div className="flex items-center gap-3">
                            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isDark ? 'bg-white/10' : 'bg-black/5'}`}>
                                <span className={`material-symbols-outlined ${isDark ? 'text-white/80' : 'text-primary/80'}`} aria-hidden="true">person</span>
                            </div>
                            <div>
                                <p className={`font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>
                                    {selectedReport.userName || 'Unknown User'}
                                </p>
                                <p className={`text-sm ${isDark ? 'text-white/80' : 'text-primary/80'}`}>{selectedReport.userEmail}</p>
                            </div>
                            <span className={`ml-auto px-2 py-0.5 text-[10px] font-bold uppercase rounded-full ${getRoleColor(selectedReport.userRole)}`}>
                                {selectedReport.userRole || 'member'}
                            </span>
                        </div>

                        <div className={`p-4 rounded-xl ${isDark ? 'bg-white/10' : 'bg-black/5'}`}>
                            <p className={`text-sm font-medium mb-1 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>Description</p>
                            <p className={`${isDark ? 'text-white' : 'text-primary'}`}>{selectedReport.description}</p>
                        </div>

                        {selectedReport.screenshotUrl && (
                            <div>
                                <p className={`text-sm font-medium mb-2 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>Screenshot</p>
                                <a href={selectedReport.screenshotUrl} target="_blank" rel="noopener noreferrer">
                                    <img 
                                        src={selectedReport.screenshotUrl} 
                                        alt="Bug screenshot" 
                                        className="w-full rounded-xl border border-black/10"
                                    />
                                </a>
                            </div>
                        )}

                        <div className="grid grid-cols-2 gap-3">
                            <div className={`p-3 rounded-xl ${isDark ? 'bg-white/10' : 'bg-black/5'}`}>
                                <p className={`text-xs font-medium mb-1 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Submitted</p>
                                <p className={`text-sm ${isDark ? 'text-white' : 'text-primary'}`}>{formatCardTimestamp(selectedReport.createdAt)}</p>
                            </div>
                            {selectedReport.pageUrl && (
                                <div className={`p-3 rounded-xl ${isDark ? 'bg-white/10' : 'bg-black/5'}`}>
                                    <p className={`text-xs font-medium mb-1 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>Page</p>
                                    <p className={`text-sm truncate ${isDark ? 'text-white' : 'text-primary'}`}>{selectedReport.pageUrl}</p>
                                </div>
                            )}
                        </div>

                        <div>
                            <p className={`text-sm font-medium mb-2 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>Status</p>
                            <div className="flex gap-2">
                                {['open', 'in_progress', 'resolved'].map(status => (
                                    <button
                                        key={status}
                                        onClick={() => handleUpdateStatus(status)}
                                        disabled={isSaving}
                                        className={`flex-1 py-2 px-3 min-h-[44px] rounded-xl text-sm font-medium transition-all ${
                                            selectedReport.status === status
                                                ? getBugReportStatusColor(status)
                                                : isDark ? 'bg-white/10 text-white/80 hover:bg-white/15' : 'bg-black/5 text-primary/80 hover:bg-black/10'
                                        }`}
                                    >
                                        {status.replace('_', ' ').charAt(0).toUpperCase() + status.replace('_', ' ').slice(1)}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {selectedReport.resolvedBy && (
                            <div className={`p-3 rounded-xl ${isDark ? 'bg-green-900/20' : 'bg-green-50'}`}>
                                <p className={`text-xs font-medium ${isDark ? 'text-green-400' : 'text-green-700'}`}>
                                    Resolved by {selectedReport.resolvedBy} {selectedReport.resolvedAt ? formatRelativeTime(selectedReport.resolvedAt) : ''}
                                </p>
                            </div>
                        )}

                        <div>
                            <p className={`text-sm font-medium mb-2 ${isDark ? 'text-white/80' : 'text-primary/80'}`}>Staff Notes</p>
                            <textarea
                                value={staffNotes}
                                onChange={(e) => setStaffNotes(e.target.value)}
                                placeholder="Add internal notes..."
                                rows={3}
                                className={`w-full rounded-xl px-4 py-3 text-sm resize-none ${
                                    isDark 
                                        ? 'bg-white/10 border border-white/25 text-white placeholder:text-white/60' 
                                        : 'bg-black/5 border border-black/10 text-primary placeholder:text-primary/70'
                                }`}
                            />
                            <button
                                onClick={handleSaveNotes}
                                disabled={isSaving || staffNotes === (selectedReport.staffNotes || '')}
                                className={`mt-2 px-4 py-2 min-h-[44px] rounded-xl text-sm font-medium transition-all disabled:opacity-50 ${
                                    isDark ? 'bg-accent text-primary' : 'bg-primary text-white'
                                }`}
                            >
                                Save Notes
                            </button>
                        </div>

                        <button
                            onClick={handleDelete}
                            disabled={isSaving}
                            className={`w-full py-3 min-h-[44px] rounded-xl text-red-500 font-medium text-sm transition-colors ${
                                isDark ? 'hover:bg-red-500/10' : 'hover:bg-red-50'
                            }`}
                        >
                            Delete Report
                        </button>
                    </div>
                )}
            </ModalShell>
            <ConfirmDialogComponent />
        </div>
    );
};

export default BugReportsAdmin;

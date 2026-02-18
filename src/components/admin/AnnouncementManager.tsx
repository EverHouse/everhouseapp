import React, { useState, useEffect, useCallback } from 'react';
import { useData, Announcement } from '../../contexts/DataContext';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useToast } from '../Toast';
import { SlideUpDrawer } from '../SlideUpDrawer';

interface AnnouncementManagerProps {
    triggerCreate?: number;
}

interface SheetStatus {
    connected: boolean;
    sheetId: string | null;
    sheetUrl: string | null;
}

const AnnouncementManager: React.FC<AnnouncementManagerProps> = ({ triggerCreate }) => {
    const { setPageReady } = usePageReady();
    const { showToast } = useToast();
    const { announcements, addAnnouncement, updateAnnouncement, deleteAnnouncement, refreshAnnouncements } = useData();
    const [isEditing, setIsEditing] = useState(false);
    const [editId, setEditId] = useState<string | null>(null);
    const [newItem, setNewItem] = useState<Partial<Announcement>>({ type: 'announcement' });

    const [sheetStatus, setSheetStatus] = useState<SheetStatus>({ connected: false, sheetId: null, sheetUrl: null });
    const [sheetLoading, setSheetLoading] = useState(false);
    const [syncingFrom, setSyncingFrom] = useState(false);
    const [syncingTo, setSyncingTo] = useState(false);
    const [exporting, setExporting] = useState(false);

    useEffect(() => {
        setPageReady(true);
    }, [setPageReady]);

    const fetchSheetStatus = useCallback(async () => {
        try {
            const res = await fetch('/api/announcements/sheets/status', { credentials: 'include' });
            if (res.ok) {
                const data = await res.json();
                setSheetStatus(data);
            }
        } catch {
        }
    }, []);

    useEffect(() => {
        fetchSheetStatus();
    }, [fetchSheetStatus]);

    const openCreate = () => {
        setNewItem({ type: 'announcement' });
        setEditId(null);
        setIsEditing(true);
    };

    useEffect(() => {
        if (triggerCreate && triggerCreate > 0) {
            openCreate();
        }
    }, [triggerCreate]);

    const openEdit = (item: Announcement) => {
        setNewItem(item);
        setEditId(item.id);
        setIsEditing(true);
    };

    const handleSave = async () => {
        if(!newItem.title) return;
        const ann = {
            id: editId || undefined,
            title: newItem.title,
            desc: newItem.desc || '',
            type: newItem.type || 'update',
            date: newItem.date || 'Just now',
            startDate: newItem.startDate,
            endDate: newItem.endDate,
            linkType: newItem.linkType,
            linkTarget: newItem.linkTarget,
            notifyMembers: newItem.notifyMembers,
            showAsBanner: newItem.showAsBanner
        };

        try {
            if (editId) {
                await updateAnnouncement(ann);
                showToast('Announcement updated', 'success');
            } else {
                await addAnnouncement(ann);
                showToast('Announcement created', 'success');
            }
            setIsEditing(false);
        } catch (err) {
            console.error('Failed to save announcement:', err);
            showToast('Failed to save announcement', 'error');
        }
    };

    const handleDelete = async (id: string) => {
        try {
            await deleteAnnouncement(id);
            showToast('Announcement deleted', 'success');
        } catch (err) {
            console.error('Failed to delete announcement:', err);
            showToast('Failed to delete announcement', 'error');
        }
    };

    const handleExportCSV = async () => {
        setExporting(true);
        try {
            const res = await fetch('/api/announcements/export', { credentials: 'include' });
            if (!res.ok) throw new Error('Export failed');
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'announcements_export.csv';
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(url);
            showToast('Announcements exported', 'success');
        } catch {
            showToast('Failed to export announcements', 'error');
        } finally {
            setExporting(false);
        }
    };

    const handleConnectSheet = async () => {
        setSheetLoading(true);
        try {
            const res = await fetch('/api/announcements/sheets/connect', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' }
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Failed to create sheet');
            }
            const data = await res.json();
            setSheetStatus({ connected: true, sheetId: data.sheetId, sheetUrl: data.sheetUrl });
            showToast('Google Sheet created and linked', 'success');
        } catch (err: unknown) {
            showToast((err instanceof Error ? err.message : String(err)) || 'Failed to connect Google Sheet', 'error');
        } finally {
            setSheetLoading(false);
        }
    };

    const handleSyncFromSheet = async () => {
        setSyncingFrom(true);
        try {
            const res = await fetch('/api/announcements/sheets/sync-from', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' }
            });
            if (!res.ok) throw new Error('Sync failed');
            const data = await res.json();
            const parts: string[] = [];
            if (data.created > 0) parts.push(`${data.created} new`);
            if (data.updated > 0) parts.push(`${data.updated} updated`);
            if (parts.length === 0) parts.push('No changes found');
            showToast(`Synced from Sheet: ${parts.join(', ')}`, 'success');
            if (refreshAnnouncements) await refreshAnnouncements();
        } catch {
            showToast('Failed to sync from Google Sheet', 'error');
        } finally {
            setSyncingFrom(false);
        }
    };

    const handleSyncToSheet = async () => {
        setSyncingTo(true);
        try {
            const res = await fetch('/api/announcements/sheets/sync-to', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' }
            });
            if (!res.ok) throw new Error('Sync failed');
            const data = await res.json();
            showToast(`Pushed ${data.pushed} announcements to Sheet`, 'success');
        } catch {
            showToast('Failed to push to Google Sheet', 'error');
        } finally {
            setSyncingTo(false);
        }
    };

    const handleDisconnectSheet = async () => {
        setSheetLoading(true);
        try {
            const res = await fetch('/api/announcements/sheets/disconnect', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' }
            });
            if (!res.ok) throw new Error('Disconnect failed');
            setSheetStatus({ connected: false, sheetId: null, sheetUrl: null });
            showToast('Google Sheet disconnected', 'success');
        } catch {
            showToast('Failed to disconnect Google Sheet', 'error');
        } finally {
            setSheetLoading(false);
        }
    };

    return (
        <div className="animate-pop-in">
            <SlideUpDrawer 
                isOpen={isEditing} 
                onClose={() => setIsEditing(false)} 
                title={editId ? 'Edit Announcement' : 'New Announcement'}
                maxHeight="large"
                stickyFooter={
                    <div className="flex gap-3 p-4">
                        <button 
                            onClick={() => setIsEditing(false)} 
                            className="flex-1 py-3 rounded-xl bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 font-medium hover:bg-gray-200 dark:hover:bg-white/20 transition-colors tactile-btn"
                        >
                            Cancel
                        </button>
                        <button 
                            onClick={handleSave} 
                            className="flex-1 py-3 rounded-xl bg-primary text-white font-medium shadow-md hover:bg-primary/90 transition-colors tactile-btn"
                        >
                            Post
                        </button>
                    </div>
                }
            >
                <div className="p-5 space-y-4">
                    <input className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast" placeholder="Title" value={newItem.title || ''} onChange={e => setNewItem({...newItem, title: e.target.value})} />
                    <textarea className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast resize-none" placeholder="Description" rows={3} value={newItem.desc || ''} onChange={e => setNewItem({...newItem, desc: e.target.value})} />
                    
                    <div className="flex items-center justify-between py-2">
                        <div className="flex-1">
                            <label className="text-sm font-medium text-gray-700 dark:text-white">Send push notification to all members</label>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Notify members via push notification and in-app alert</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setNewItem({...newItem, notifyMembers: !newItem.notifyMembers})}
                            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-fast ease-in-out focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ${newItem.notifyMembers ? 'bg-primary' : 'bg-gray-200 dark:bg-white/20'}`}
                            role="switch"
                            aria-checked={newItem.notifyMembers || false}
                        >
                            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-fast ease-in-out ${newItem.notifyMembers ? 'translate-x-5' : 'translate-x-0'}`} />
                        </button>
                    </div>
                    
                    <div className="flex items-center justify-between py-2">
                        <div className="flex-1">
                            <label className="text-sm font-medium text-gray-700 dark:text-white">Show as Homepage Banner</label>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Display this announcement as a promotional banner on the member dashboard</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setNewItem({...newItem, showAsBanner: !newItem.showAsBanner})}
                            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-fast ease-in-out focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ${newItem.showAsBanner ? 'bg-lavender' : 'bg-gray-200 dark:bg-white/20'}`}
                            role="switch"
                            aria-checked={newItem.showAsBanner || false}
                        >
                            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-fast ease-in-out ${newItem.showAsBanner ? 'translate-x-5' : 'translate-x-0'}`} />
                        </button>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1.5 block">Start Date</label>
                            <input type="date" className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast" value={newItem.startDate || ''} onChange={e => setNewItem({...newItem, startDate: e.target.value})} />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1.5 block">End Date</label>
                            <input type="date" className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast" value={newItem.endDate || ''} onChange={e => setNewItem({...newItem, endDate: e.target.value})} />
                        </div>
                    </div>
                    
                    <div className="space-y-3 pt-2 border-t border-gray-200 dark:border-white/25">
                        <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 block">Link Destination</label>
                        <div className="grid grid-cols-2 gap-2">
                            <button type="button" onClick={() => setNewItem({...newItem, linkType: undefined, linkTarget: undefined})} className={`py-2 px-3 rounded-xl text-xs font-bold transition-colors ${!newItem.linkType ? 'bg-primary text-white' : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/70'}`}>None</button>
                            <button type="button" onClick={() => setNewItem({...newItem, linkType: 'events', linkTarget: undefined})} className={`py-2 px-3 rounded-xl text-xs font-bold transition-colors ${newItem.linkType === 'events' ? 'bg-primary text-white' : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/70'}`}>Events</button>
                            <button type="button" onClick={() => setNewItem({...newItem, linkType: 'wellness', linkTarget: undefined})} className={`py-2 px-3 rounded-xl text-xs font-bold transition-colors ${newItem.linkType === 'wellness' ? 'bg-primary text-white' : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/70'}`}>Wellness</button>
                            <button type="button" onClick={() => setNewItem({...newItem, linkType: 'golf', linkTarget: undefined})} className={`py-2 px-3 rounded-xl text-xs font-bold transition-colors ${newItem.linkType === 'golf' ? 'bg-primary text-white' : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/70'}`}>Book Golf</button>
                            <button type="button" onClick={() => setNewItem({...newItem, linkType: 'external', linkTarget: newItem.linkTarget || ''})} className={`py-2 px-3 rounded-xl text-xs font-bold transition-colors col-span-2 ${newItem.linkType === 'external' ? 'bg-primary text-white' : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/70'}`}>External URL</button>
                        </div>
                        {newItem.linkType === 'external' && (
                            <input 
                                type="url" 
                                className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3 rounded-xl text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast" 
                                placeholder="https://example.com" 
                                value={newItem.linkTarget || ''} 
                                onChange={e => setNewItem({...newItem, linkTarget: e.target.value})} 
                            />
                        )}
                    </div>
                </div>
            </SlideUpDrawer>

            <div className="space-y-4 animate-slide-up-stagger" style={{ '--stagger-index': 0 } as React.CSSProperties}>
                {/* Tools Bar */}
                <div className="bg-white dark:bg-surface-dark rounded-xl border border-gray-200 dark:border-white/20 p-4 space-y-4">
                    <div className="flex items-center justify-between">
                        <h3 className="text-sm font-bold uppercase text-gray-500 dark:text-gray-400 flex items-center gap-2">
                            <span aria-hidden="true" className="material-symbols-outlined text-[16px]">build</span>
                            Tools
                        </h3>
                        <button
                            onClick={handleExportCSV}
                            disabled={exporting || announcements.length === 0}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/20 transition-colors disabled:opacity-50"
                            aria-label="Export announcements as CSV"
                        >
                            <span aria-hidden="true" className="material-symbols-outlined text-[14px]">download</span>
                            {exporting ? 'Exporting...' : 'Export CSV'}
                        </button>
                    </div>

                    {/* Google Sheets Section */}
                    <div className="border-t border-gray-200 dark:border-white/15 pt-3">
                        <div className="flex items-center gap-2 mb-3">
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none">
                                <rect x="3" y="3" width="18" height="18" rx="2" fill="#0F9D58"/>
                                <rect x="6" y="7" width="12" height="2" rx="0.5" fill="white"/>
                                <rect x="6" y="11" width="12" height="2" rx="0.5" fill="white"/>
                                <rect x="6" y="15" width="12" height="2" rx="0.5" fill="white"/>
                                <rect x="11" y="7" width="2" height="10" rx="0.5" fill="#0F9D58" opacity="0.3"/>
                            </svg>
                            <span className="text-sm font-bold text-gray-700 dark:text-white">Google Sheets Sync</span>
                            {sheetStatus.connected && (
                                <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded">Connected</span>
                            )}
                        </div>

                        {!sheetStatus.connected ? (
                            <div className="space-y-2">
                                <p className="text-xs text-gray-500 dark:text-gray-400">
                                    Create a Google Sheet to manage announcements from a spreadsheet. Add or edit rows in the sheet, then sync them into the app.
                                </p>
                                <button
                                    onClick={handleConnectSheet}
                                    disabled={sheetLoading}
                                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium bg-primary text-white hover:bg-primary/90 transition-colors disabled:opacity-50"
                                >
                                    <span aria-hidden="true" className="material-symbols-outlined text-[16px]">add_link</span>
                                    {sheetLoading ? 'Creating Sheet...' : 'Create & Connect Sheet'}
                                </button>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                <a
                                    href={sheetStatus.sheetUrl || '#'}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                                >
                                    <span aria-hidden="true" className="material-symbols-outlined text-[14px]">open_in_new</span>
                                    Open Google Sheet
                                </a>

                                <div className="flex flex-wrap gap-2">
                                    <button
                                        onClick={handleSyncFromSheet}
                                        disabled={syncingFrom}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors disabled:opacity-50"
                                        aria-label="Pull changes from Google Sheet"
                                    >
                                        <span aria-hidden="true" className="material-symbols-outlined text-[14px]">cloud_download</span>
                                        {syncingFrom ? 'Syncing...' : 'Pull from Sheet'}
                                    </button>
                                    <button
                                        onClick={handleSyncToSheet}
                                        disabled={syncingTo}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors disabled:opacity-50"
                                        aria-label="Push announcements to Google Sheet"
                                    >
                                        <span aria-hidden="true" className="material-symbols-outlined text-[14px]">cloud_upload</span>
                                        {syncingTo ? 'Pushing...' : 'Push to Sheet'}
                                    </button>
                                    <button
                                        onClick={handleDisconnectSheet}
                                        disabled={sheetLoading}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors disabled:opacity-50"
                                        aria-label="Disconnect Google Sheet"
                                    >
                                        <span aria-hidden="true" className="material-symbols-outlined text-[14px]">link_off</span>
                                        Disconnect
                                    </button>
                                </div>

                                <p className="text-[11px] text-gray-400 dark:text-gray-500">
                                    Add rows in the Google Sheet and use "Pull from Sheet" to import them. Changes made in the app auto-sync to the sheet.
                                </p>
                            </div>
                        )}
                    </div>
                </div>

                {announcements.length > 0 && (
                    <h3 className="text-sm font-bold uppercase text-gray-500 dark:text-gray-400 mb-3 flex items-center gap-2">
                        <span aria-hidden="true" className="material-symbols-outlined text-amber-500 text-[18px]">campaign</span>
                        Announcements ({announcements.length})
                    </h3>
                )}
                {[...announcements].sort((a, b) => {
                    const idA = parseInt(a.id) || 0;
                    const idB = parseInt(b.id) || 0;
                    return idB - idA;
                }).map((item, index) => (
                    <div key={item.id} onClick={() => openEdit(item)} className="bg-white dark:bg-surface-dark p-4 rounded-xl border border-gray-200 dark:border-white/20 shadow-sm flex justify-between items-start cursor-pointer hover:border-primary/30 transition-all duration-fast animate-slide-up-stagger tactile-row" style={{ '--stagger-index': index + 1 } as React.CSSProperties}>
                        <div>
                            <div className="flex items-center gap-2 mb-1.5">
                                <span className="w-2 h-2 rounded-full bg-accent"></span>
                                <span className="text-[10px] text-gray-500 dark:text-gray-600">{item.date}</span>
                                {item.showAsBanner && (
                                    <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase bg-lavender/20 text-lavender rounded">Banner</span>
                                )}
                            </div>
                            <h4 className="font-bold text-gray-900 dark:text-white mb-1">{item.title}</h4>
                            <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed mb-2">{item.desc}</p>
                            {(item.startDate || item.endDate) && (
                                <div className="inline-flex items-center gap-1 bg-gray-100 dark:bg-white/5 px-2 py-1 rounded text-xs text-gray-500 dark:text-gray-400">
                                    <span aria-hidden="true" className="material-symbols-outlined text-[12px]">calendar_today</span>
                                    <span>{item.startDate} {item.endDate ? `- ${item.endDate}` : ''}</span>
                                </div>
                            )}
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); handleDelete(item.id); }} className="text-gray-500 hover:text-red-500 p-2 min-w-[44px] min-h-[44px]" aria-label="Delete announcement">
                            <span aria-hidden="true" className="material-symbols-outlined">delete</span>
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default AnnouncementManager;

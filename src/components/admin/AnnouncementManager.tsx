import React, { useState, useEffect } from 'react';
import { useData, Announcement } from '../../contexts/DataContext';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useToast } from '../Toast';
import ModalShell from '../ModalShell';

interface AnnouncementManagerProps {
    triggerCreate?: number;
}

const AnnouncementManager: React.FC<AnnouncementManagerProps> = ({ triggerCreate }) => {
    const { setPageReady } = usePageReady();
    const { showToast } = useToast();
    const { announcements, addAnnouncement, updateAnnouncement, deleteAnnouncement } = useData();
    const [isEditing, setIsEditing] = useState(false);
    const [editId, setEditId] = useState<string | null>(null);
    const [newItem, setNewItem] = useState<Partial<Announcement>>({ type: 'announcement' });

    useEffect(() => {
        setPageReady(true);
    }, [setPageReady]);

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
        const ann: any = {
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

    return (
        <div className="animate-pop-in">
            <ModalShell isOpen={isEditing} onClose={() => setIsEditing(false)} showCloseButton={false}>
                <div className="p-6 space-y-4">
                    <h3 className="font-bold text-lg text-primary dark:text-white flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-accent" />
                        {editId ? 'Edit Announcement' : 'New Announcement'}
                    </h3>
                    <input className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" placeholder="Title" value={newItem.title || ''} onChange={e => setNewItem({...newItem, title: e.target.value})} />
                    <textarea className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all resize-none" placeholder="Description" rows={3} value={newItem.desc || ''} onChange={e => setNewItem({...newItem, desc: e.target.value})} />
                    
                    <div className="flex items-center justify-between py-2">
                        <div className="flex-1">
                            <label className="text-sm font-medium text-gray-700 dark:text-white">Send push notification to all members</label>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Notify members via push notification and in-app alert</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setNewItem({...newItem, notifyMembers: !newItem.notifyMembers})}
                            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ${newItem.notifyMembers ? 'bg-primary' : 'bg-gray-200 dark:bg-white/20'}`}
                            role="switch"
                            aria-checked={newItem.notifyMembers || false}
                        >
                            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${newItem.notifyMembers ? 'translate-x-5' : 'translate-x-0'}`} />
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
                            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ${newItem.showAsBanner ? 'bg-lavender' : 'bg-gray-200 dark:bg-white/20'}`}
                            role="switch"
                            aria-checked={newItem.showAsBanner || false}
                        >
                            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${newItem.showAsBanner ? 'translate-x-5' : 'translate-x-0'}`} />
                        </button>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1.5 block">Start Date</label>
                            <input type="date" className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" value={newItem.startDate || ''} onChange={e => setNewItem({...newItem, startDate: e.target.value})} />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1.5 block">End Date</label>
                            <input type="date" className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" value={newItem.endDate || ''} onChange={e => setNewItem({...newItem, endDate: e.target.value})} />
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
                                className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3 rounded-xl text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" 
                                placeholder="https://example.com" 
                                value={newItem.linkTarget || ''} 
                                onChange={e => setNewItem({...newItem, linkTarget: e.target.value})} 
                            />
                        )}
                    </div>
                    <div className="flex gap-3 justify-end pt-2">
                        <button onClick={() => setIsEditing(false)} className="px-5 py-2.5 text-gray-500 dark:text-white/80 font-bold hover:bg-gray-100 dark:hover:bg-white/10 rounded-xl transition-colors">Cancel</button>
                        <button onClick={handleSave} className="px-6 py-2.5 bg-primary text-white rounded-xl font-bold shadow-md hover:bg-primary/90 transition-colors">Post</button>
                    </div>
                </div>
            </ModalShell>

            <div className="space-y-4 animate-pop-in" style={{animationDelay: '0.1s'}}>
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
                    <div key={item.id} onClick={() => openEdit(item)} className="bg-white dark:bg-surface-dark p-4 rounded-xl border border-gray-200 dark:border-white/20 shadow-sm flex justify-between items-start cursor-pointer hover:border-primary/30 transition-all animate-pop-in" style={{animationDelay: `${0.15 + index * 0.05}s`}}>
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
                        <button onClick={(e) => { e.stopPropagation(); handleDelete(item.id); }} className="text-gray-500 hover:text-red-500 p-2 min-w-[44px] min-h-[44px]">
                            <span aria-hidden="true" className="material-symbols-outlined">delete</span>
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default AnnouncementManager;

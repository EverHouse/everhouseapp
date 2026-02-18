import React, { useState, useEffect } from 'react';
import { useData, Announcement } from '../../contexts/DataContext';
import { useToast } from '../Toast';
import { SlideUpDrawer } from '../SlideUpDrawer';

interface AnnouncementFormDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  editItem?: Announcement | null;
}

export const AnnouncementFormDrawer: React.FC<AnnouncementFormDrawerProps> = ({ 
  isOpen, 
  onClose,
  editItem = null
}) => {
  const { showToast } = useToast();
  const { addAnnouncement, updateAnnouncement } = useData();
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState<Partial<Announcement>>({ type: 'announcement' });

  useEffect(() => {
    if (isOpen) {
      if (editItem) {
        setFormData(editItem);
      } else {
        setFormData({ type: 'announcement' });
      }
    }
  }, [isOpen, editItem]);

  const handleSave = async () => {
    if (!formData.title) {
      showToast('Title is required', 'error');
      return;
    }
    setSaving(true);
    try {
      const ann: any = {
        id: editItem?.id || undefined,
        title: formData.title,
        desc: formData.desc || '',
        type: formData.type || 'announcement',
        date: formData.date || 'Just now',
        startDate: formData.startDate,
        endDate: formData.endDate,
        linkType: formData.linkType,
        linkTarget: formData.linkTarget,
        notifyMembers: formData.notifyMembers,
        showAsBanner: formData.showAsBanner
      };

      if (editItem?.id) {
        await updateAnnouncement(ann);
        showToast('Announcement updated', 'success');
      } else {
        await addAnnouncement(ann);
        showToast('Announcement created', 'success');
      }
      onClose();
    } catch (err) {
      console.error('Failed to save announcement:', err);
      showToast('Failed to save announcement', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setFormData({ type: 'announcement' });
    onClose();
  };

  return (
    <SlideUpDrawer 
      isOpen={isOpen} 
      onClose={handleClose} 
      title={editItem ? 'Edit Announcement' : 'New Announcement'}
      maxHeight="large"
      stickyFooter={
        <div className="flex gap-3 p-4">
          <button 
            onClick={handleClose} 
            className="flex-1 py-3 rounded-xl bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 font-medium hover:bg-gray-200 dark:hover:bg-white/20 transition-colors"
          >
            Cancel
          </button>
          <button 
            onClick={handleSave}
            disabled={saving || !formData.title}
            className="flex-1 py-3 rounded-xl bg-primary text-white font-medium shadow-md hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving ? (
              <>
                <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
                Saving...
              </>
            ) : (
              'Post'
            )}
          </button>
        </div>
      }
    >
      <div className="p-5 space-y-4">
        <input 
          className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast" 
          placeholder="Title" 
          value={formData.title || ''} 
          onChange={e => setFormData({...formData, title: e.target.value})} 
        />
        <textarea 
          className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3.5 rounded-xl text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast resize-none" 
          placeholder="Description" 
          rows={3} 
          value={formData.desc || ''} 
          onChange={e => setFormData({...formData, desc: e.target.value})} 
        />
        
        <div className="flex items-center justify-between py-2">
          <div className="flex-1">
            <label className="text-sm font-medium text-gray-700 dark:text-white">Send push notification to all members</label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Notify members via push notification and in-app alert</p>
          </div>
          <button
            type="button"
            onClick={() => setFormData({...formData, notifyMembers: !formData.notifyMembers})}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-fast ease-in-out focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ${formData.notifyMembers ? 'bg-primary' : 'bg-gray-200 dark:bg-white/20'}`}
            role="switch"
            aria-checked={formData.notifyMembers || false}
          >
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-fast ease-in-out ${formData.notifyMembers ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
        
        <div className="flex items-center justify-between py-2">
          <div className="flex-1">
            <label className="text-sm font-medium text-gray-700 dark:text-white">Show as Homepage Banner</label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Display this announcement as a promotional banner on the member dashboard</p>
          </div>
          <button
            type="button"
            onClick={() => setFormData({...formData, showAsBanner: !formData.showAsBanner})}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-fast ease-in-out focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ${formData.showAsBanner ? 'bg-lavender' : 'bg-gray-200 dark:bg-white/20'}`}
            role="switch"
            aria-checked={formData.showAsBanner || false}
          >
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-fast ease-in-out ${formData.showAsBanner ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
        
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1.5 block">Start Date</label>
            <input 
              type="date" 
              className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast" 
              value={formData.startDate || ''} 
              onChange={e => setFormData({...formData, startDate: e.target.value})} 
            />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1.5 block">End Date</label>
            <input 
              type="date" 
              className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3 rounded-xl text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast" 
              value={formData.endDate || ''} 
              onChange={e => setFormData({...formData, endDate: e.target.value})} 
            />
          </div>
        </div>
        
        <div className="space-y-3 pt-2 border-t border-gray-200 dark:border-white/25">
          <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 block">Link Destination</label>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setFormData({...formData, linkType: undefined, linkTarget: undefined})} className={`py-2 px-3 rounded-xl text-xs font-bold transition-colors ${!formData.linkType ? 'bg-primary text-white' : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/70'}`}>None</button>
            <button type="button" onClick={() => setFormData({...formData, linkType: 'events', linkTarget: undefined})} className={`py-2 px-3 rounded-xl text-xs font-bold transition-colors ${formData.linkType === 'events' ? 'bg-primary text-white' : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/70'}`}>Events</button>
            <button type="button" onClick={() => setFormData({...formData, linkType: 'wellness', linkTarget: undefined})} className={`py-2 px-3 rounded-xl text-xs font-bold transition-colors ${formData.linkType === 'wellness' ? 'bg-primary text-white' : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/70'}`}>Wellness</button>
            <button type="button" onClick={() => setFormData({...formData, linkType: 'golf', linkTarget: undefined})} className={`py-2 px-3 rounded-xl text-xs font-bold transition-colors ${formData.linkType === 'golf' ? 'bg-primary text-white' : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/70'}`}>Book Golf</button>
            <button type="button" onClick={() => setFormData({...formData, linkType: 'external', linkTarget: formData.linkTarget || ''})} className={`py-2 px-3 rounded-xl text-xs font-bold transition-colors col-span-2 ${formData.linkType === 'external' ? 'bg-primary text-white' : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/70'}`}>External URL</button>
          </div>
          {formData.linkType === 'external' && (
            <input 
              type="url" 
              className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-3 rounded-xl text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast" 
              placeholder="https://example.com" 
              value={formData.linkTarget || ''} 
              onChange={e => setFormData({...formData, linkTarget: e.target.value})} 
            />
          )}
        </div>
      </div>
    </SlideUpDrawer>
  );
};

export default AnnouncementFormDrawer;

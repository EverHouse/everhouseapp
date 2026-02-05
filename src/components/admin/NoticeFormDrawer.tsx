import React, { useState, useEffect } from 'react';
import { useToast } from '../Toast';
import { SlideUpDrawer } from '../SlideUpDrawer';

function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<p>/gi, '')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface NoticeFormData {
  id?: number;
  title: string;
  member_notice: string;
  notes: string;
  start_date: string;
  end_date: string;
  affected_areas: string;
  notice_type: string;
  reason: string;
  notify_members: boolean;
}

interface NoticeFormDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  editItem?: Partial<NoticeFormData> | null;
  onSuccess?: () => void;
}

export const NoticeFormDrawer: React.FC<NoticeFormDrawerProps> = ({ 
  isOpen, 
  onClose,
  editItem = null,
  onSuccess
}) => {
  const { showToast } = useToast();
  const [saving, setSaving] = useState(false);
  const [noticeTypes, setNoticeTypes] = useState<{id: number; name: string}[]>([]);
  const [closureReasons, setClosureReasons] = useState<{id: number; label: string; isActive: boolean}[]>([]);
  const today = new Date().toISOString().split('T')[0];
  
  const [formData, setFormData] = useState<NoticeFormData>({
    title: '',
    member_notice: '',
    notes: '',
    start_date: today,
    end_date: today,
    affected_areas: 'none',
    notice_type: '',
    reason: '',
    notify_members: false
  });

  useEffect(() => {
    fetch('/api/notice-types', { credentials: 'include' })
      .then(r => r.json())
      .then(data => setNoticeTypes(data || []))
      .catch(() => {});
    
    fetch('/api/closure-reasons', { credentials: 'include' })
      .then(r => r.json())
      .then(data => setClosureReasons(data || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (isOpen) {
      if (editItem) {
        setFormData({
          id: editItem.id,
          title: editItem.title || '',
          member_notice: editItem.member_notice || '',
          notes: stripHtml(editItem.notes),
          start_date: editItem.start_date || today,
          end_date: editItem.end_date || today,
          affected_areas: editItem.affected_areas || 'none',
          notice_type: editItem.notice_type || '',
          reason: editItem.reason || '',
          notify_members: editItem.notify_members || false
        });
      } else {
        setFormData({
          title: '',
          member_notice: '',
          notes: '',
          start_date: today,
          end_date: today,
          affected_areas: 'none',
          notice_type: noticeTypes[0]?.name || 'General',
          reason: '',
          notify_members: false
        });
      }
    }
  }, [isOpen, editItem, today, noticeTypes]);

  const handleSave = async () => {
    if (!formData.start_date) {
      showToast('Start date is required', 'error');
      return;
    }
    setSaving(true);
    try {
      const url = editItem?.id ? `/api/closures/${editItem.id}` : '/api/closures';
      const method = editItem?.id ? 'PUT' : 'POST';
      
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(formData)
      });
      
      if (!response.ok) {
        throw new Error('Failed to save notice');
      }
      
      showToast(editItem?.id ? 'Notice updated' : 'Notice created', 'success');
      onSuccess?.();
      onClose();
    } catch (err) {
      console.error('Failed to save notice:', err);
      showToast('Failed to save notice', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setFormData({
      title: '',
      member_notice: '',
      notes: '',
      start_date: today,
      end_date: today,
      affected_areas: 'none',
      notice_type: '',
      reason: '',
      notify_members: false
    });
    onClose();
  };

  const isBlocking = formData.affected_areas && formData.affected_areas !== 'none' && formData.affected_areas !== '';

  return (
    <SlideUpDrawer 
      isOpen={isOpen} 
      onClose={handleClose} 
      title={editItem?.id ? 'Edit Notice' : 'New Notice'}
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
            disabled={saving || !formData.start_date}
            className={`flex-1 py-3 rounded-xl font-medium text-white transition-colors disabled:opacity-50 flex items-center justify-center gap-2 ${
              isBlocking
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-amber-500 hover:bg-amber-600'
            }`}
          >
            {saving ? (
              <>
                <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
                Saving...
              </>
            ) : (
              editItem?.id ? 'Update' : 'Create'
            )}
          </button>
        </div>
      }
    >
      <div className="p-5 space-y-4">
        <div>
          <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Reason Category</label>
          <select
            value={formData.notice_type}
            onChange={e => setFormData({...formData, notice_type: e.target.value})}
            className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
          >
            <option value="">Select category...</option>
            {noticeTypes.map(type => (
              <option key={type.id} value={type.name}>{type.name}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Syncs with Google Calendar bracket prefix
          </p>
        </div>

        <div>
          <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Title <span className="text-[9px] font-normal normal-case text-gray-400">(internal only)</span></label>
          <input 
            type="text" 
            placeholder="e.g., Holiday Closure, Maintenance" 
            className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white placeholder:text-gray-500 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" 
            value={formData.title} 
            onChange={e => setFormData({...formData, title: e.target.value})} 
          />
        </div>

        <div>
          <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Note to Members</label>
          <textarea 
            className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white placeholder:text-gray-500 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all resize-none" 
            placeholder="Message shown to members about this notice..." 
            rows={2} 
            value={formData.member_notice} 
            onChange={e => setFormData({...formData, member_notice: e.target.value})} 
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Visible to members in the app
          </p>
        </div>

        <div>
          <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Staff Notes</label>
          <textarea 
            className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white placeholder:text-gray-500 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all resize-none" 
            placeholder="Internal notes, event details, logistics..." 
            rows={3} 
            value={formData.notes} 
            onChange={e => setFormData({...formData, notes: e.target.value})} 
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Internal only - syncs with Google Calendar
          </p>
        </div>

        <div>
          <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Closure Reason</label>
          <select
            value={formData.reason}
            onChange={e => setFormData({...formData, reason: e.target.value})}
            className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
          >
            <option value="">Select reason...</option>
            {closureReasons.filter(r => r.isActive).map(reason => (
              <option key={reason.id} value={reason.label}>{reason.label}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Shown as a badge to members
          </p>
        </div>

        <div>
          <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-2 block">Affected Resources</label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500"></span> Selecting resources will block bookings</span>
            <br />
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500"></span> "None" is for announcements only</span>
          </p>
          <div className="space-y-2 p-3 bg-gray-50 dark:bg-black/20 rounded-xl border border-gray-200 dark:border-white/25">
            <label className="flex items-center gap-2 cursor-pointer">
              <input 
                type="checkbox" 
                checked={formData.affected_areas === 'none' || formData.affected_areas === ''}
                onChange={(e) => {
                  if (e.target.checked) {
                    setFormData({...formData, affected_areas: 'none'});
                  }
                }}
                className="w-4 h-4 text-primary rounded border-gray-300 focus:ring-primary"
              />
              <span className="text-sm text-gray-700 dark:text-white">None (announcement only)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input 
                type="checkbox" 
                checked={formData.affected_areas === 'all'}
                onChange={(e) => {
                  if (e.target.checked) {
                    setFormData({...formData, affected_areas: 'all'});
                  }
                }}
                className="w-4 h-4 text-red-500 rounded border-gray-300 focus:ring-red-500"
              />
              <span className="text-sm text-gray-700 dark:text-white">All (full facility closure)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input 
                type="checkbox" 
                checked={formData.affected_areas === 'simulators'}
                onChange={(e) => {
                  if (e.target.checked) {
                    setFormData({...formData, affected_areas: 'simulators'});
                  }
                }}
                className="w-4 h-4 text-red-500 rounded border-gray-300 focus:ring-red-500"
              />
              <span className="text-sm text-gray-700 dark:text-white">Simulators only</span>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Start Date *</label>
            <input 
              type="date" 
              className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" 
              value={formData.start_date} 
              onChange={e => setFormData({...formData, start_date: e.target.value})} 
            />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">End Date</label>
            <input 
              type="date" 
              className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" 
              value={formData.end_date} 
              onChange={e => setFormData({...formData, end_date: e.target.value})} 
            />
          </div>
        </div>

        <div className="flex items-center justify-between py-2">
          <div className="flex-1">
            <label className="text-sm font-medium text-gray-700 dark:text-white">Notify members</label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Send push notification about this notice</p>
          </div>
          <button
            type="button"
            onClick={() => setFormData({...formData, notify_members: !formData.notify_members})}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${formData.notify_members ? 'bg-amber-500' : 'bg-gray-200 dark:bg-white/20'}`}
            role="switch"
            aria-checked={formData.notify_members}
          >
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${formData.notify_members ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
      </div>
    </SlideUpDrawer>
  );
};

export default NoticeFormDrawer;

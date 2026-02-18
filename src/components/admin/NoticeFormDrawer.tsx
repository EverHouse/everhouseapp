import React, { useState, useEffect } from 'react';
import { useToast } from '../Toast';
import { SlideUpDrawer } from '../SlideUpDrawer';
import { isBlockingClosure } from '../../utils/closureUtils';

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
  notes: string;
  start_date: string;
  start_time: string;
  end_date: string;
  end_time: string;
  affected_areas: string;
  visibility: string;
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
  const [resources, setResources] = useState<{id: number; name: string; type: string}[]>([]);
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());
  const today = new Date().toISOString().split('T')[0];
  
  const [formData, setFormData] = useState<NoticeFormData>({
    title: '',
    notes: '',
    start_date: today,
    start_time: '',
    end_date: today,
    end_time: '',
    affected_areas: 'entire_facility',
    visibility: '',
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

    fetch('/api/resources', { credentials: 'include' })
      .then(r => r.json())
      .then(data => setResources(data || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (isOpen) {
      if (editItem) {
        setFormData({
          id: editItem.id,
          title: editItem.title || '',
          notes: stripHtml(editItem.notes),
          start_date: editItem.start_date || today,
          start_time: editItem.start_time || '',
          end_date: editItem.end_date || today,
          end_time: editItem.end_time || '',
          affected_areas: editItem.affected_areas || 'entire_facility',
          visibility: editItem.visibility || '',
          notice_type: editItem.notice_type || '',
          reason: editItem.reason || '',
          notify_members: editItem.notify_members || false
        });
      } else {
        setFormData({
          title: '',
          notes: '',
          start_date: today,
          start_time: '',
          end_date: today,
          end_time: '',
          affected_areas: 'entire_facility',
          visibility: '',
          notice_type: '',
          reason: '',
          notify_members: false
        });
      }
      setTouchedFields(new Set());
    }
  }, [isOpen, editItem, today]);

  const markTouched = (field: string) => {
    setTouchedFields(prev => new Set(prev).add(field));
  };

  const closureValidation = {
    notice_type: !formData.notice_type?.trim(),
    affected_areas: !formData.affected_areas?.trim(),
    visibility: !formData.visibility?.trim()
  };

  const isClosureFormValid = !closureValidation.notice_type && !closureValidation.affected_areas && !closureValidation.visibility;

  const bays = resources.filter(r => r.type === 'simulator');

  const formatAffectedAreas = (areas: string | null) => {
    if (!areas) return 'Unknown';
    if (areas === 'entire_facility') return 'Entire Facility';
    if (areas === 'all_bays') return 'All Bays';
    if (areas === 'conference_room') return 'Conference Room';
    if (areas === 'none') return 'No booking restrictions';
    
    const areaList = areas.split(',').map(a => a.trim());
    const formatted = areaList.map(area => {
      if (area === 'entire_facility') return 'Entire Facility';
      if (area === 'all_bays') return 'All Bays';
      if (area === 'conference_room') return 'Conference Room';
      if (area === 'Conference Room') return 'Conference Room';
      if (area === 'none') return 'No booking restrictions';
      if (area.startsWith('bay_')) {
        const areaId = parseInt(area.replace('bay_', ''));
        const bay = bays.find(b => b.id === areaId);
        return bay ? bay.name : area;
      }
      return area;
    });
    return formatted.join(', ');
  };

  const handleSave = async () => {
    if (!formData.start_date || !isClosureFormValid) {
      showToast('Please fill in all required fields', 'error');
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
      notes: '',
      start_date: today,
      start_time: '',
      end_date: today,
      end_time: '',
      affected_areas: 'entire_facility',
      visibility: '',
      notice_type: '',
      reason: '',
      notify_members: false
    });
    setTouchedFields(new Set());
    onClose();
  };

  const isBlocking = isBlockingClosure(formData.affected_areas);

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
            className="flex-1 py-3 rounded-xl bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-white/70 font-medium hover:bg-gray-200 dark:hover:bg-white/20 transition-colors"
          >
            Cancel
          </button>
          <button 
            onClick={handleSave}
            disabled={saving || !formData.start_date || !isClosureFormValid}
            className={`flex-1 py-3 rounded-xl font-medium text-white transition-colors disabled:opacity-50 flex items-center justify-center gap-2 ${
              isBlocking
                ? 'bg-red-500 hover:bg-red-600 disabled:bg-red-300'
                : 'bg-amber-500 hover:bg-amber-600 disabled:bg-amber-300'
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
        <div className="space-y-3">
          <div>
            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Reason Category *</label>
            <select
              value={formData.notice_type}
              onChange={e => setFormData({...formData, notice_type: e.target.value})}
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
              value={formData.title} 
              onChange={e => setFormData({...formData, title: e.target.value})} 
            />
          </div>

          <div>
            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Closure Reason</label>
            <select
              value={formData.reason}
              onChange={e => setFormData({...formData, reason: e.target.value})}
              className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast"
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
            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Notes</label>
            <textarea 
              className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast resize-none" 
              placeholder="Internal notes, event details, logistics..." 
              rows={3} 
              value={formData.notes} 
              onChange={e => setFormData({...formData, notes: e.target.value})} 
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
                  checked={formData.affected_areas === 'none' || formData.affected_areas === ''}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setFormData({...formData, affected_areas: 'none'});
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
                  checked={formData.affected_areas === 'entire_facility'}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setFormData({...formData, affected_areas: 'entire_facility'});
                    } else {
                      setFormData({...formData, affected_areas: 'none'});
                    }
                  }}
                  className="w-4 h-4 rounded border-gray-300 text-red-500 focus:ring-red-500"
                />
                <span className="text-sm text-primary dark:text-white font-medium">Entire Facility</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input 
                  type="checkbox" 
                  checked={formData.affected_areas.split(',').some(a => a.trim() === 'conference_room')}
                  onChange={(e) => {
                    const currentSet = new Set(formData.affected_areas.split(',').map(a => a.trim()).filter(a => a && a !== 'none' && a !== 'entire_facility'));
                    if (e.target.checked) {
                      currentSet.add('conference_room');
                    } else {
                      currentSet.delete('conference_room');
                    }
                    setFormData({...formData, affected_areas: currentSet.size > 0 ? Array.from(currentSet).join(',') : 'none'});
                  }}
                  className="w-4 h-4 rounded border-gray-300 text-red-500 focus:ring-red-500"
                />
                <span className="text-sm text-primary dark:text-white">Conference Room</span>
              </label>
              {bays.map(bay => (
                <label key={bay.id} className="flex items-center gap-2 cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={formData.affected_areas.split(',').some(a => a.trim() === `bay_${bay.id}`)}
                    onChange={(e) => {
                      const currentSet = new Set(formData.affected_areas.split(',').map(a => a.trim()).filter(a => a && a !== 'none' && a !== 'entire_facility'));
                      if (e.target.checked) {
                        currentSet.add(`bay_${bay.id}`);
                      } else {
                        currentSet.delete(`bay_${bay.id}`);
                      }
                      setFormData({...formData, affected_areas: currentSet.size > 0 ? Array.from(currentSet).join(',') : 'none'});
                    }}
                    className="w-4 h-4 rounded border-gray-300 text-red-500 focus:ring-red-500"
                  />
                  <span className="text-sm text-primary dark:text-white">{bay.name}</span>
                </label>
              ))}
            </div>
            {formData.affected_areas && formData.affected_areas !== 'none' && formData.affected_areas !== 'entire_facility' && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Selected: {formatAffectedAreas(formData.affected_areas)}
              </p>
            )}
          </div>

          <div>
            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Visibility *</label>
            <select
              value={formData.visibility}
              onChange={e => setFormData({...formData, visibility: e.target.value})}
              onBlur={() => markTouched('visibility')}
              className={`w-full border bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast ${
                touchedFields.has('visibility') && closureValidation.visibility 
                  ? 'border-red-500 dark:border-red-500' 
                  : 'border-gray-200 dark:border-white/20'
              }`}
            >
              <option value="">Select visibility...</option>
              <option value="Public">Public</option>
              <option value="Staff Only">Staff Only</option>
              <option value="Private">Private</option>
              <option value="Draft">Draft</option>
            </select>
            {touchedFields.has('visibility') && closureValidation.visibility && (
              <p className="text-xs text-red-500 mt-1">Visibility is required</p>
            )}
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Controls who can see this notice
            </p>
          </div>

          <div>
            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-2 block">Member Visibility</label>
            <div className="p-3 bg-gray-50 dark:bg-black/20 rounded-xl border border-gray-200 dark:border-white/25">
              <label className={`flex items-center gap-3 ${formData.affected_areas !== 'none' ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}>
                <input 
                  type="checkbox" 
                  checked={formData.affected_areas !== 'none' || formData.notify_members}
                  disabled={formData.affected_areas !== 'none'}
                  onChange={(e) => {
                    if (formData.affected_areas === 'none') {
                      setFormData({...formData, notify_members: e.target.checked});
                    }
                  }}
                  className="w-5 h-5 rounded border-gray-300 text-primary focus:ring-primary disabled:opacity-50"
                />
                <div>
                  <span className="text-sm font-medium text-primary dark:text-white">Show to Members</span>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {formData.affected_areas !== 'none' 
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
              value={formData.start_date} 
              onChange={e => setFormData({...formData, start_date: e.target.value})} 
            />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">Start Time</label>
            <input 
              type="time" 
              className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast" 
              value={formData.start_time} 
              onChange={e => setFormData({...formData, start_time: e.target.value})} 
            />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">End Date</label>
            <input 
              type="date" 
              className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast" 
              value={formData.end_date} 
              onChange={e => setFormData({...formData, end_date: e.target.value})} 
            />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400 mb-1 block">End Time</label>
            <input 
              type="time" 
              className="w-full border border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-black/30 p-2.5 rounded-xl text-sm text-primary dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast" 
              value={formData.end_time} 
              onChange={e => setFormData({...formData, end_time: e.target.value})} 
            />
          </div>
        </div>
      </div>
    </SlideUpDrawer>
  );
};

export default NoticeFormDrawer;

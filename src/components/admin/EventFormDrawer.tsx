import React, { useState, useEffect } from 'react';
import { useToast } from '../Toast';
import { SlideUpDrawer } from '../SlideUpDrawer';

interface EventFormDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export const EventFormDrawer: React.FC<EventFormDrawerProps> = ({ isOpen, onClose, onSuccess }) => {
  const { showToast } = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());
  const [formData, setFormData] = useState({
    title: '',
    category: 'Social',
    event_date: '',
    start_time: '',
    end_time: '',
    location: '',
    image_url: '',
    max_attendees: null as number | null,
    external_url: '',
    description: '',
    visibility: 'public',
    block_simulators: false,
    block_conference_room: false,
  });

  const eventValidation = {
    category: !formData.category || formData.category === '' || formData.category === 'Event',
    description: !formData.description || formData.description.trim() === '',
    location: !formData.location || formData.location.trim() === '',
  };

  const isEventFormValid = !eventValidation.category && !eventValidation.description && !eventValidation.location;

  const markTouched = (field: string) => setTouchedFields(prev => new Set(prev).add(field));

  useEffect(() => {
    if (isOpen) {
      setFormData({
        title: '',
        category: 'Social',
        event_date: '',
        start_time: '',
        end_time: '',
        location: '',
        image_url: '',
        max_attendees: null,
        external_url: '',
        description: '',
        visibility: 'public',
        block_simulators: false,
        block_conference_room: false,
      });
      setTouchedFields(new Set());
      setError(null);
    }
  }, [isOpen]);

  const handleSave = async () => {
    setError(null);

    if (!formData.title?.trim()) {
      setError('Title is required');
      return;
    }
    if (!formData.event_date) {
      setError('Date is required');
      return;
    }
    if (!formData.start_time) {
      setError('Start time is required');
      return;
    }

    const payload = {
      title: formData.title.trim(),
      description: formData.description || '',
      event_date: formData.event_date,
      start_time: formData.start_time,
      end_time: formData.end_time || formData.start_time,
      location: formData.location || 'The Lounge',
      category: formData.category || 'Social',
      image_url: formData.image_url || null,
      max_attendees: formData.max_attendees || null,
      external_url: formData.external_url || null,
      visibility: formData.visibility || 'public',
      block_bookings: false,
      block_simulators: formData.block_simulators || false,
      block_conference_room: formData.block_conference_room || false,
    };

    setSaving(true);
    try {
      const response = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create event');
      }

      showToast('Event created successfully', 'success');
      onSuccess?.();
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create event';
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setFormData({
      title: '',
      category: 'Social',
      event_date: '',
      start_time: '',
      end_time: '',
      location: '',
      image_url: '',
      max_attendees: null,
      external_url: '',
      description: '',
      visibility: 'public',
      block_simulators: false,
      block_conference_room: false,
    });
    setTouchedFields(new Set());
    setError(null);
    onClose();
  };

  return (
    <SlideUpDrawer
      isOpen={isOpen}
      onClose={handleClose}
      title="Add Event"
      maxHeight="large"
      stickyFooter={
        <div className="flex gap-3 p-4">
          <button
            onClick={handleClose}
            className="flex-1 py-3 rounded-xl bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !isEventFormValid}
            className="flex-1 py-3 rounded-xl bg-brand-green text-white font-medium hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>}
            {saving ? 'Saving...' : 'Add Event'}
          </button>
        </div>
      }
    >
      <div className="p-5 space-y-4">
        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg text-red-700 dark:text-red-400 text-sm">
            {error}
          </div>
        )}
        <div>
          <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Title *</label>
          <input className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60" placeholder="Event title" value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Category *</label>
          <select
            className={`w-full border bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white ${
              touchedFields.has('category') && eventValidation.category
                ? 'border-red-500 dark:border-red-500'
                : 'border-gray-200 dark:border-white/25'
            }`}
            value={formData.category}
            onChange={e => setFormData({...formData, category: e.target.value})}
            onBlur={() => markTouched('category')}
          >
            <option value="">Select category...</option>
            <option value="Social">Social</option>
            <option value="Golf">Golf</option>
            <option value="Tournaments">Tournaments</option>
            <option value="Dining">Dining</option>
            <option value="Networking">Networking</option>
            <option value="Workshops">Workshops</option>
            <option value="Family">Family</option>
            <option value="Entertainment">Entertainment</option>
            <option value="Charity">Charity</option>
          </select>
          {touchedFields.has('category') && eventValidation.category && (
            <p className="text-xs text-red-500 mt-1">Category is required</p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Date *</label>
          <input type="date" className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white" value={formData.event_date} onChange={e => setFormData({...formData, event_date: e.target.value})} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Start Time</label>
          <input type="time" className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white" value={formData.start_time} onChange={e => setFormData({...formData, start_time: e.target.value})} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">End Time</label>
          <input type="time" className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white" value={formData.end_time} onChange={e => setFormData({...formData, end_time: e.target.value})} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Location *</label>
          <input
            className={`w-full border bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 ${
              touchedFields.has('location') && eventValidation.location
                ? 'border-red-500 dark:border-red-500'
                : 'border-gray-200 dark:border-white/25'
            }`}
            placeholder="Event location"
            value={formData.location}
            onChange={e => setFormData({...formData, location: e.target.value})}
            onBlur={() => markTouched('location')}
          />
          {touchedFields.has('location') && eventValidation.location && (
            <p className="text-xs text-red-500 mt-1">Location is required</p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Image URL (optional)</label>
          <input className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60" placeholder="https://..." value={formData.image_url} onChange={e => setFormData({...formData, image_url: e.target.value})} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Max Attendees (optional)</label>
          <input type="number" className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60" placeholder="e.g., 50" value={formData.max_attendees || ''} onChange={e => setFormData({...formData, max_attendees: parseInt(e.target.value) || null})} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">External Link (optional)</label>
          <input className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60" placeholder="https://..." value={formData.external_url} onChange={e => setFormData({...formData, external_url: e.target.value})} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Description *</label>
          <textarea
            className={`w-full border bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 resize-none ${
              touchedFields.has('description') && eventValidation.description
                ? 'border-red-500 dark:border-red-500'
                : 'border-gray-200 dark:border-white/25'
            }`}
            placeholder="Event description"
            rows={3}
            value={formData.description}
            onChange={e => setFormData({...formData, description: e.target.value})}
            onBlur={() => markTouched('description')}
          />
          {touchedFields.has('description') && eventValidation.description && (
            <p className="text-xs text-red-500 mt-1">Description is required</p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">Visibility</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setFormData({...formData, visibility: 'public'})}
              className={`flex-1 py-2.5 px-4 rounded-lg font-bold text-sm transition-all duration-fast flex items-center justify-center gap-2 ${
                formData.visibility === 'public'
                  ? 'bg-primary text-white shadow-md'
                  : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/70 border border-gray-200 dark:border-white/25'
              }`}
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[18px]">public</span>
              Public
            </button>
            <button
              type="button"
              onClick={() => setFormData({...formData, visibility: 'members'})}
              className={`flex-1 py-2.5 px-4 rounded-lg font-bold text-sm transition-all duration-fast flex items-center justify-center gap-2 ${
                formData.visibility === 'members'
                  ? 'bg-primary text-white shadow-md'
                  : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-white/70 border border-gray-200 dark:border-white/25'
              }`}
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[18px]">lock</span>
              Members Only
            </button>
          </div>
          <p className="text-xs text-gray-600 dark:text-gray-500 mt-1">
            {formData.visibility === 'public' ? 'Visible on public website and member portal' : 'Only visible to logged-in members'}
          </p>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-700/50">
            <div className="flex-1">
              <label className="font-bold text-sm text-gray-700 dark:text-white flex items-center gap-2">
                <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-amber-600">sports_golf</span>
                Block Simulators
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Prevents simulator bay bookings during this event's time slot
              </p>
            </div>
            <button
              type="button"
              onClick={() => setFormData({...formData, block_simulators: !formData.block_simulators})}
              className={`relative w-12 h-6 rounded-full transition-colors ${
                formData.block_simulators
                  ? 'bg-amber-500'
                  : 'bg-gray-300 dark:bg-white/20'
              }`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform ${
                formData.block_simulators ? 'translate-x-6' : 'translate-x-0'
              }`} />
            </button>
          </div>
          <div className="flex items-center justify-between p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-700/50">
            <div className="flex-1">
              <label className="font-bold text-sm text-gray-700 dark:text-white flex items-center gap-2">
                <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-blue-600">meeting_room</span>
                Block Conference Room
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Prevents conference room bookings during this event's time slot
              </p>
            </div>
            <button
              type="button"
              onClick={() => setFormData({...formData, block_conference_room: !formData.block_conference_room})}
              className={`relative w-12 h-6 rounded-full transition-colors ${
                formData.block_conference_room
                  ? 'bg-blue-500'
                  : 'bg-gray-300 dark:bg-white/20'
              }`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform ${
                formData.block_conference_room ? 'translate-x-6' : 'translate-x-0'
              }`} />
            </button>
          </div>
        </div>
      </div>
    </SlideUpDrawer>
  );
};

export default EventFormDrawer;

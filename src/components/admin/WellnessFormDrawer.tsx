import React, { useState, useEffect } from 'react';
import { useToast } from '../Toast';
import { SlideUpDrawer } from '../SlideUpDrawer';

interface WellnessFormDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export const WellnessFormDrawer: React.FC<WellnessFormDrawerProps> = ({ isOpen, onClose, onSuccess }) => {
  const { showToast } = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());

  const categories = ['Classes', 'MedSpa', 'Recovery', 'Therapy', 'Nutrition', 'Personal Training', 'Mindfulness', 'Outdoors', 'General'];

  const [formData, setFormData] = useState({
    title: '',
    date: '',
    time: '09:00',
    endTime: '10:00',
    instructor: '',
    category: 'Classes',
    capacity: null as number | null,
    waitlist_enabled: false,
    description: '',
    external_url: '',
    visibility: 'public',
    block_simulators: false,
    block_conference_room: false,
  });

  const wellnessValidation = {
    instructor: !formData.instructor?.trim() || formData.instructor === 'TBD',
    category: !formData.category || formData.category === 'Wellness',
    capacity: !formData.capacity || formData.capacity <= 0,
  };

  const isWellnessFormValid = !wellnessValidation.instructor && !wellnessValidation.category && !wellnessValidation.capacity;

  const markTouched = (field: string) => setTouchedFields(prev => new Set(prev).add(field));

  const calculateDuration = (startTime: string, endTime: string): string => {
    if (!startTime || !endTime) return '60 min';
    const [startHours, startMins] = startTime.split(':').map(Number);
    const [endHours, endMins] = endTime.split(':').map(Number);
    let durationMins = (endHours * 60 + endMins) - (startHours * 60 + startMins);
    if (durationMins <= 0) durationMins += 24 * 60;
    return `${durationMins} min`;
  };

  useEffect(() => {
    if (isOpen) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      setFormData({
        title: '',
        date: tomorrow.toISOString().split('T')[0],
        time: '09:00',
        endTime: '10:00',
        instructor: '',
        category: 'Classes',
        capacity: null,
        waitlist_enabled: false,
        description: '',
        external_url: '',
        visibility: 'public',
        block_simulators: false,
        block_conference_room: false,
      });
      setTouchedFields(new Set());
      setError(null);
    }
  }, [isOpen]);

  const handleSave = async () => {
    if (!formData.title || !formData.time || !formData.endTime || !formData.instructor || !formData.date || !formData.capacity) {
      setError('Please fill in all required fields');
      return;
    }

    setError(null);
    setSaving(true);

    try {
      const { endTime, ...restFormData } = formData;
      const duration = calculateDuration(formData.time, endTime);
      const spotsDisplay = formData.capacity ? `${formData.capacity} spots` : 'Unlimited';
      const payload = {
        ...restFormData,
        duration,
        spots: spotsDisplay,
        image_url: null,
        external_url: formData.external_url || null,
        visibility: formData.visibility || 'public',
        block_bookings: false,
        block_simulators: formData.block_simulators || false,
        block_conference_room: formData.block_conference_room || false,
        capacity: formData.capacity || null,
        waitlist_enabled: formData.waitlist_enabled || false,
      };

      const response = await fetch('/api/wellness-classes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create wellness');
      }

      showToast('Wellness created successfully', 'success');
      onSuccess?.();
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create wellness';
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setFormData({
      title: '',
      date: tomorrow.toISOString().split('T')[0],
      time: '09:00',
      endTime: '10:00',
      instructor: '',
      category: 'Classes',
      capacity: null,
      waitlist_enabled: false,
      description: '',
      external_url: '',
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
      title="Add Wellness"
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
            disabled={saving || !isWellnessFormValid}
            className="flex-1 py-3 rounded-xl bg-brand-green text-white font-medium hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving && <span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>}
            {saving ? 'Saving...' : 'Add Wellness'}
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
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Title *</label>
          <input
            type="text"
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            placeholder="Morning Yoga Flow"
            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Date *</label>
          <input
            type="date"
            value={formData.date}
            onChange={(e) => setFormData({ ...formData, date: e.target.value })}
            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Start Time *</label>
          <input
            type="time"
            value={formData.time}
            onChange={(e) => setFormData({ ...formData, time: e.target.value })}
            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">End Time *</label>
          <input
            type="time"
            value={formData.endTime}
            onChange={(e) => setFormData({ ...formData, endTime: e.target.value })}
            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Instructor *</label>
          <input
            type="text"
            value={formData.instructor}
            onChange={(e) => setFormData({ ...formData, instructor: e.target.value })}
            onBlur={() => markTouched('instructor')}
            placeholder="Jane Smith"
            className={`w-full p-3 rounded-lg border bg-gray-50 dark:bg-black/30 text-primary dark:text-white ${
              touchedFields.has('instructor') && wellnessValidation.instructor
                ? 'border-red-500 dark:border-red-500'
                : 'border-gray-200 dark:border-white/25'
            }`}
          />
          {touchedFields.has('instructor') && wellnessValidation.instructor && (
            <p className="text-xs text-red-500 mt-1">Please enter a valid instructor name</p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Category *</label>
          <select
            value={formData.category}
            onChange={(e) => setFormData({ ...formData, category: e.target.value })}
            onBlur={() => markTouched('category')}
            className={`w-full p-3 rounded-lg border bg-gray-50 dark:bg-black/30 text-primary dark:text-white ${
              touchedFields.has('category') && wellnessValidation.category
                ? 'border-red-500 dark:border-red-500'
                : 'border-gray-200 dark:border-white/25'
            }`}
          >
            <option value="">Select category...</option>
            {categories.map(cat => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
          {touchedFields.has('category') && wellnessValidation.category && (
            <p className="text-xs text-red-500 mt-1">Please select a valid category</p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Capacity *</label>
          <input
            type="number"
            value={formData.capacity || ''}
            onChange={(e) => setFormData({ ...formData, capacity: parseInt(e.target.value) || null })}
            onBlur={() => markTouched('capacity')}
            placeholder="e.g., 20"
            className={`w-full p-3 rounded-lg border bg-gray-50 dark:bg-black/30 text-primary dark:text-white ${
              touchedFields.has('capacity') && wellnessValidation.capacity
                ? 'border-red-500 dark:border-red-500'
                : 'border-gray-200 dark:border-white/25'
            }`}
          />
          {touchedFields.has('capacity') && wellnessValidation.capacity && (
            <p className="text-xs text-red-500 mt-1">Capacity must be greater than 0</p>
          )}
        </div>
        <div className="flex items-center justify-between p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-700/50">
          <div className="flex-1">
            <label className="font-bold text-sm text-gray-700 dark:text-white flex items-center gap-2">
              <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-purple-600">format_list_numbered</span>
              Enable Waitlist
            </label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Allow members to join a waitlist when class is full
            </p>
          </div>
          <button
            type="button"
            onClick={() => setFormData({...formData, waitlist_enabled: !formData.waitlist_enabled})}
            className={`relative w-12 h-6 rounded-full transition-colors ${
              formData.waitlist_enabled
                ? 'bg-purple-500'
                : 'bg-gray-300 dark:bg-white/20'
            }`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform ${
              formData.waitlist_enabled ? 'translate-x-6' : 'translate-x-0'
            }`} />
          </button>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
          <textarea
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            placeholder="A gentle flow to start your day..."
            rows={3}
            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white resize-none"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">External Link (optional)</label>
          <input
            type="url"
            value={formData.external_url}
            onChange={(e) => setFormData({ ...formData, external_url: e.target.value })}
            placeholder="https://..."
            className="w-full p-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Visibility</label>
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
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-700/50">
            <div className="flex-1">
              <label className="font-bold text-sm text-gray-700 dark:text-white flex items-center gap-2">
                <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-amber-600">sports_golf</span>
                Block Simulators
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Prevents simulator bay bookings during this class
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
                Prevents conference room bookings during this class
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

export default WellnessFormDrawer;

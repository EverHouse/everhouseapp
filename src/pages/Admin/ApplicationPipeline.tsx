import React, { useState, useEffect } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { usePageReady } from '../../contexts/PageReadyContext';
import ModalShell from '../../components/ModalShell';
import { formatRelativeTime } from '../../utils/dateUtils';

interface MembershipTier {
  id: number;
  name: string;
  price_cents: number;
  billing_interval: string;
  stripe_price_id: string | null;
  is_active: boolean;
  product_type: string;
}

interface Application {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string;
  phone: string | null;
  message: string | null;
  metadata: Record<string, unknown> | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string | null;
  user_id: number | null;
  membership_status: string | null;
  tier: string | null;
  first_login_at: string | null;
}

const STATUS_TABS = [
  { id: 'all', label: 'All', icon: 'inbox' },
  { id: 'new', label: 'New', icon: 'fiber_new' },
  { id: 'reviewing', label: 'Reviewing', icon: 'rate_review' },
  { id: 'approved', label: 'Approved', icon: 'check_circle' },
  { id: 'invited', label: 'Invited', icon: 'send' },
  { id: 'converted', label: 'Converted', icon: 'how_to_reg' },
  { id: 'declined', label: 'Declined', icon: 'cancel' },
];

const getStatusColor = (status: string) => {
  switch (status) {
    case 'new': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400';
    case 'reviewing': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
    case 'approved': return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
    case 'invited': return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400';
    case 'converted': return 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400';
    case 'declined': return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
    case 'archived': return 'bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400';
    default: return 'bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400';
  }
};

const getStatusIcon = (status: string) => {
  switch (status) {
    case 'new': return 'fiber_new';
    case 'reviewing': return 'rate_review';
    case 'approved': return 'check_circle';
    case 'invited': return 'send';
    case 'converted': return 'how_to_reg';
    case 'declined': return 'cancel';
    case 'archived': return 'archive';
    default: return 'circle';
  }
};

const ApplicationPipeline: React.FC = () => {
  const { setPageReady } = usePageReady();
  const [applications, setApplications] = useState<Application[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeStatus, setActiveStatus] = useState('all');
  const [selectedApp, setSelectedApp] = useState<Application | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [selectedTierId, setSelectedTierId] = useState<number | null>(null);
  const [isSendingInvite, setIsSendingInvite] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [applicationsRef] = useAutoAnimate();

  useEffect(() => {
    if (!isLoading) {
      setPageReady(true);
    }
  }, [isLoading, setPageReady]);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const fetchApplications = async () => {
    try {
      const res = await fetch('/api/admin/applications', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setApplications(data);
      }
    } catch (err) {
      console.error('Failed to fetch applications:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchTiers = async () => {
    try {
      const res = await fetch('/api/membership-tiers?active=true', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setTiers(data.filter((t: MembershipTier) => t.product_type === 'subscription' && t.stripe_price_id));
      }
    } catch (err) {
      console.error('Failed to fetch tiers:', err);
    }
  };

  useEffect(() => {
    fetchApplications();
    fetchTiers();
  }, []);

  const filteredApplications = activeStatus === 'all'
    ? applications
    : applications.filter(a => a.status === activeStatus);

  const openDetail = async (app: Application) => {
    setSelectedApp(app);
    setNotes(app.notes || '');
    setSelectedTierId(null);
    setIsDetailOpen(true);

    if (app.status === 'new') {
      try {
        await fetch(`/api/admin/applications/${app.id}/status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ status: 'read' }),
        });
        setApplications(prev => prev.map(a => a.id === app.id ? { ...a, status: 'read' } : a));
        setSelectedApp(prev => prev ? { ...prev, status: 'read' } : null);
      } catch (err) {
        console.error('Failed to mark as read:', err);
      }
    }
  };

  const handleUpdateStatus = async (status: string) => {
    if (!selectedApp) return;
    setIsSaving(true);
    try {
      const res = await fetch(`/api/admin/applications/${selectedApp.id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        setApplications(prev => prev.map(a => a.id === selectedApp.id ? { ...a, status } : a));
        setSelectedApp(prev => prev ? { ...prev, status } : null);
        setToast({ message: `Status updated to ${status}`, type: 'success' });
      }
    } catch (err) {
      console.error('Failed to update status:', err);
      setToast({ message: 'Failed to update status', type: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveNotes = async () => {
    if (!selectedApp) return;
    setIsSaving(true);
    try {
      const res = await fetch(`/api/admin/applications/${selectedApp.id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: selectedApp.status, notes }),
      });
      if (res.ok) {
        setApplications(prev => prev.map(a => a.id === selectedApp.id ? { ...a, notes } : a));
        setSelectedApp(prev => prev ? { ...prev, notes } : null);
        setToast({ message: 'Notes saved', type: 'success' });
      }
    } catch (err) {
      console.error('Failed to save notes:', err);
      setToast({ message: 'Failed to save notes', type: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSendInvite = async () => {
    if (!selectedApp || !selectedTierId) return;
    setIsSendingInvite(true);
    try {
      const res = await fetch(`/api/admin/applications/${selectedApp.id}/send-invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ tierId: selectedTierId }),
      });
      if (res.ok) {
        setApplications(prev => prev.map(a => a.id === selectedApp.id ? { ...a, status: 'invited' } : a));
        setSelectedApp(prev => prev ? { ...prev, status: 'invited' } : null);
        setToast({ message: 'Checkout invite sent successfully!', type: 'success' });
      } else {
        const data = await res.json();
        setToast({ message: data.error || 'Failed to send invite', type: 'error' });
      }
    } catch (err) {
      console.error('Failed to send invite:', err);
      setToast({ message: 'Failed to send invite', type: 'error' });
    } finally {
      setIsSendingInvite(false);
    }
  };

  const statusCounts = applications.reduce((acc, app) => {
    acc[app.status] = (acc[app.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="animate-slide-up-stagger" style={{ '--stagger-index': 0 } as React.CSSProperties}>
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-semibold flex items-center gap-2 animate-slide-up-stagger ${
          toast.type === 'success' 
            ? 'bg-green-600 text-white' 
            : 'bg-red-600 text-white'
        }`}>
          <span className="material-symbols-outlined text-lg" aria-hidden="true">
            {toast.type === 'success' ? 'check_circle' : 'error'}
          </span>
          {toast.message}
        </div>
      )}

      <div className="flex gap-2 overflow-x-auto pb-4 mb-4 scrollbar-hide -mx-4 px-4 animate-slide-up-stagger scroll-fade-right" style={{ '--stagger-index': 1 } as React.CSSProperties}>
        {STATUS_TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveStatus(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-2 min-h-[44px] rounded-full text-[10px] sm:text-xs font-bold uppercase tracking-wide whitespace-nowrap transition-all duration-fast flex-shrink-0 ${
              activeStatus === tab.id
                ? 'bg-primary dark:bg-lavender text-white shadow-md'
                : 'bg-white dark:bg-white/10 text-gray-600 dark:text-white/80 border border-gray-200 dark:border-white/25'
            }`}
          >
            <span className="material-symbols-outlined text-[14px] sm:text-[16px]" aria-hidden="true">{tab.icon}</span>
            {tab.label}
            {tab.id !== 'all' && statusCounts[tab.id] ? (
              <span className="ml-1 bg-white/20 dark:bg-black/20 px-1.5 py-0.5 rounded-full text-[9px]">
                {statusCounts[tab.id]}
              </span>
            ) : tab.id === 'all' && applications.length > 0 ? (
              <span className="ml-1 bg-white/20 dark:bg-black/20 px-1.5 py-0.5 rounded-full text-[9px]">
                {applications.length}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <ModalShell
        isOpen={isDetailOpen && selectedApp !== null}
        onClose={() => setIsDetailOpen(false)}
        title={selectedApp ? `${selectedApp.first_name || ''} ${selectedApp.last_name || ''}`.trim() || 'Application Details' : 'Application Details'}
        size="lg"
      >
        {selectedApp && (
          <div className="p-6">
            <div className="mb-4">
              <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${getStatusColor(selectedApp.status)}`}>
                <span className="material-symbols-outlined text-[12px]" aria-hidden="true">{getStatusIcon(selectedApp.status)}</span>
                {selectedApp.status}
              </span>
            </div>

            <div className="space-y-4 mb-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-600 dark:text-gray-400 block mb-1">Email</label>
                  <a href={`mailto:${selectedApp.email}`} className="text-sm text-primary dark:text-accent hover:underline">{selectedApp.email}</a>
                </div>
                {selectedApp.phone && (
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-wider text-gray-600 dark:text-gray-400 block mb-1">Phone</label>
                    <a href={`tel:${selectedApp.phone}`} className="text-sm text-primary dark:text-accent hover:underline">{selectedApp.phone}</a>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-600 dark:text-gray-400 block mb-1">Applied</label>
                  <span className="text-sm text-gray-700 dark:text-gray-300">{formatRelativeTime(selectedApp.created_at)}</span>
                </div>
                {selectedApp.user_id && (
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-wider text-gray-600 dark:text-gray-400 block mb-1">Member Status</label>
                    <span className="text-sm text-gray-700 dark:text-gray-300">
                      {selectedApp.membership_status || 'N/A'}
                      {selectedApp.tier && ` · ${selectedApp.tier}`}
                    </span>
                  </div>
                )}
              </div>

              {selectedApp.message && (
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-600 dark:text-gray-400 block mb-1">Message</label>
                  <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-black/20 p-3 rounded-lg whitespace-pre-wrap">{selectedApp.message}</p>
                </div>
              )}

              {selectedApp.metadata && Object.keys(selectedApp.metadata).length > 0 && (
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-600 dark:text-gray-400 block mb-1">Additional Details</label>
                  <div className="bg-gray-50 dark:bg-black/20 p-3 rounded-lg text-sm">
                    {Object.entries(selectedApp.metadata).map(([key, value]) => (
                      <div key={key} className="flex gap-2 py-1 border-b border-gray-200 dark:border-white/25 last:border-0">
                        <span className="text-gray-600 dark:text-gray-300 capitalize">{key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ')}:</span>
                        <span className="text-gray-700 dark:text-gray-300">{String(value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-gray-600 dark:text-gray-400 block mb-1">Update Status</label>
                <div className="flex gap-2 flex-wrap">
                  {['reviewing', 'approved', 'declined', 'archived'].map(status => (
                    <button
                      key={status}
                      onClick={() => handleUpdateStatus(status)}
                      disabled={isSaving || selectedApp.status === status}
                      className={`px-3 py-2 min-h-[44px] rounded-lg text-xs font-bold transition-all duration-fast disabled:opacity-50 ${
                        selectedApp.status === status
                          ? 'bg-primary text-white'
                          : 'bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/20'
                      }`}
                    >
                      {status.charAt(0).toUpperCase() + status.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              {selectedApp.status === 'approved' && (
                <div className="bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-800/30 rounded-xl p-4">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-green-700 dark:text-green-400 block mb-2">
                    <span className="material-symbols-outlined text-[12px] align-middle mr-1" aria-hidden="true">send</span>
                    Send Checkout Invite
                  </label>
                  <div className="flex gap-2">
                    <select
                      value={selectedTierId || ''}
                      onChange={(e) => setSelectedTierId(e.target.value ? parseInt(e.target.value, 10) : null)}
                      className="flex-1 px-3 py-2.5 rounded-xl border bg-white dark:bg-black/30 border-gray-200 dark:border-white/20 text-gray-800 dark:text-white text-sm"
                    >
                      <option value="">Select a tier...</option>
                      {tiers.map(t => (
                        <option key={t.id} value={t.id}>
                          {t.name} - ${(t.price_cents / 100).toFixed(0)}/{t.billing_interval}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={handleSendInvite}
                      disabled={isSendingInvite || !selectedTierId}
                      className="px-4 py-2 min-h-[44px] bg-green-600 text-white rounded-xl font-bold text-sm hover:bg-green-700 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                    >
                      <span className="material-symbols-outlined text-[16px]" aria-hidden="true">send</span>
                      {isSendingInvite ? 'Sending...' : 'Send'}
                    </button>
                  </div>
                </div>
              )}

              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-gray-600 dark:text-gray-400 block mb-1">Staff Notes</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Add internal notes about this application..."
                  rows={3}
                  className="w-full border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 p-3 rounded-xl text-primary dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/60 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all duration-fast resize-none text-sm"
                />
                <button
                  onClick={handleSaveNotes}
                  disabled={isSaving}
                  className="mt-2 px-4 py-2 min-h-[44px] bg-primary text-white rounded-lg font-bold text-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {isSaving ? 'Saving...' : 'Save Notes'}
                </button>
              </div>
            </div>

            <div className="flex gap-3 justify-end border-t border-gray-200 dark:border-white/25 pt-4">
              <button onClick={() => setIsDetailOpen(false)} className="px-5 py-2 min-h-[44px] bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-white font-bold rounded-lg hover:bg-gray-200 dark:hover:bg-white/20 transition-colors text-sm">
                Close
              </button>
            </div>
          </div>
        )}
      </ModalShell>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <span className="material-symbols-outlined animate-spin text-3xl text-gray-500 dark:text-gray-400" aria-hidden="true">progress_activity</span>
        </div>
      ) : filteredApplications.length === 0 ? (
        <div className="bg-white dark:bg-surface-dark rounded-2xl p-8 text-center shadow-sm border border-gray-200 dark:border-white/20">
          <span className="material-symbols-outlined text-5xl text-gray-500 dark:text-gray-500 mb-3 block" aria-hidden="true">how_to_reg</span>
          <h3 className="text-lg font-bold text-primary dark:text-white mb-2">No Applications</h3>
          <p className="text-gray-600 dark:text-gray-300">No membership applications match your current filter.</p>
        </div>
      ) : (
        <div ref={applicationsRef} className="space-y-3 animate-slide-up-stagger" style={{ '--stagger-index': 3 } as React.CSSProperties}>
          {filteredApplications.map((app, index) => (
            <button
              key={app.id}
              onClick={() => openDetail(app)}
              className={`w-full text-left bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border cursor-pointer hover:border-primary/30 transition-colors tactile-card animate-slide-up-stagger ${
                app.status === 'new'
                  ? 'border-blue-200 dark:border-blue-800/30'
                  : app.status === 'archived'
                    ? 'border-gray-200 dark:border-white/20 opacity-60'
                    : 'border-gray-200 dark:border-white/20'
              }`}
              style={{ '--stagger-index': index + 4 } as React.CSSProperties}
            >
              <div className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                  app.status === 'new'
                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                    : app.status === 'approved'
                      ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400'
                      : app.status === 'invited'
                        ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400'
                        : app.status === 'converted'
                          ? 'bg-teal-100 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400'
                          : 'bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400'
                }`}>
                  <span className="material-symbols-outlined text-lg" aria-hidden="true">
                    {getStatusIcon(app.status)}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h4 className="font-bold text-gray-900 dark:text-white truncate flex-1">
                      {app.first_name || app.last_name
                        ? `${app.first_name || ''} ${app.last_name || ''}`.trim()
                        : app.email}
                    </h4>
                    <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${getStatusColor(app.status)}`}>
                      {app.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-gray-600 dark:text-gray-300 truncate">{app.email}</span>
                    {app.phone && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">· {app.phone}</span>
                    )}
                  </div>
                  {app.user_id && (
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="material-symbols-outlined text-[12px] text-teal-500" aria-hidden="true">verified</span>
                      <span className="text-[10px] font-semibold text-teal-600 dark:text-teal-400 uppercase tracking-wide">
                        {app.membership_status || 'User'}
                        {app.tier && ` · ${app.tier}`}
                      </span>
                    </div>
                  )}
                  {app.message && (
                    <p className="text-xs text-gray-600 dark:text-gray-300 line-clamp-1">{app.message}</p>
                  )}
                  <span className="text-[10px] text-gray-500 dark:text-gray-400 mt-2 block">{formatRelativeTime(app.created_at)}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ApplicationPipeline;

import React, { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useData } from '../../contexts/DataContext';
import { BottomSentinel } from '../../components/layout/BottomSentinel';
import BackToTop from '../../components/BackToTop';
import Toggle from '../../components/Toggle';
import Avatar from '../../components/Avatar';
import ModalShell from '../../components/ModalShell';
import StaffCommandCenter from '../../components/StaffCommandCenter';
import MenuOverlay from '../../components/MenuOverlay';
import PageErrorBoundary from '../../components/PageErrorBoundary';
import { useStaffWebSocket } from '../../hooks/useStaffWebSocket';

import { TabType, StaffBottomNav, StaffSidebar, usePendingCounts, useUnreadNotifications } from './layout';

// Lazy load admin tabs - reduces initial bundle size by deferring tab code until needed
const FaqsAdmin = lazy(() => import('./FaqsAdmin'));
const InquiriesAdmin = lazy(() => import('./InquiriesAdmin'));
const GalleryAdmin = lazy(() => import('./GalleryAdmin'));
const BugReportsAdmin = lazy(() => import('./BugReportsAdmin'));
const ChangelogTab = lazy(() => import('./tabs/ChangelogTab'));
const ToursTab = lazy(() => import('./tabs/ToursTab'));
const BlocksTab = lazy(() => import('./tabs/BlocksTab'));
const UpdatesTab = lazy(() => import('./tabs/UpdatesTab'));
const CafeTab = lazy(() => import('./tabs/CafeTab'));
const AnnouncementsTab = lazy(() => import('./tabs/AnnouncementsTab'));
const TeamTab = lazy(() => import('./tabs/TeamTab'));
const TiersTab = lazy(() => import('./tabs/TiersTab'));
const TrackmanTab = lazy(() => import('./tabs/TrackmanTab'));
const DirectoryTab = lazy(() => import('./tabs/DirectoryTab'));
const EventsTab = lazy(() => import('./tabs/EventsTab'));
const SimulatorTab = lazy(() => import('./tabs/SimulatorTab'));
const DataIntegrityTab = lazy(() => import('./tabs/DataIntegrityTab'));

// Loading fallback for lazy-loaded tabs - matches app aesthetic
const TabLoadingFallback = () => (
  <div className="flex items-center justify-center py-20">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#293515] dark:border-[#F2F2EC]" />
  </div>
);

const AdminDashboard: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { actualUser } = useData();
  const [activeTab, setActiveTab] = useState<TabType>('home');
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  
  const { pendingRequestsCount, refetch: refetchPendingCounts } = usePendingCounts();
  const { unreadNotifCount } = useUnreadNotifications(actualUser?.email);

  const handleGlobalBookingEvent = useCallback(() => {
    console.log('[AdminDashboard] Received global booking event, refreshing counts');
    refetchPendingCounts();
  }, [refetchPendingCounts]);

  const { isConnected: staffWsConnected } = useStaffWebSocket({
    onBookingEvent: handleGlobalBookingEvent,
    debounceMs: 500
  });

  useEffect(() => {
    const tabParam = searchParams.get('tab') as TabType | null;
    const validTabs: TabType[] = ['home', 'cafe', 'events', 'announcements', 'directory', 'simulator', 'team', 'faqs', 'inquiries', 'gallery', 'tiers', 'blocks', 'changelog', 'training', 'updates', 'tours', 'bugs', 'trackman', 'data-integrity'];
    if (tabParam && validTabs.includes(tabParam)) {
      setActiveTab(tabParam);
    } else if (!tabParam) {
      setActiveTab('home');
    }
  }, [searchParams]);

  const handleTabChange = (tab: TabType) => {
    setActiveTab(tab);
    if (tab === 'home') {
      setSearchParams({});
    } else {
      setSearchParams({ tab });
    }
    window.scrollTo(0, 0);
  };

  useEffect(() => {
    const state = location.state as { showPasswordSetup?: boolean } | null;
    if (state?.showPasswordSetup) {
      navigate('/profile', { state: { showPasswordSetup: true } });
    }
  }, [location.state, navigate]);
  
  useEffect(() => {
    if (!actualUser || (actualUser.role !== 'admin' && actualUser.role !== 'staff')) {
        navigate('/login');
    }
  }, [actualUser, navigate]);

  if (!actualUser || (actualUser.role !== 'admin' && actualUser.role !== 'staff')) return null;

  const getTabTitle = () => {
    switch (activeTab) {
      case 'home': return 'Dashboard';
      case 'cafe': return 'Cafe Menu';
      case 'events': return 'Calendar';
      case 'announcements': return 'News';
      case 'directory': return 'Directory';
      case 'simulator': return 'Bookings';
      case 'team': return 'Team';
      case 'faqs': return 'FAQs';
      case 'inquiries': return 'Inquiries';
      case 'gallery': return 'Gallery';
      case 'tiers': return 'Tiers';
      case 'blocks': return 'Notices';
      case 'changelog': return 'Changelog';
      case 'bugs': return 'Bug Reports';
      case 'training': return 'Training';
      case 'updates': return 'Updates';
      case 'tours': return 'Tours';
      case 'trackman': return 'Trackman Import';
      case 'data-integrity': return 'Data Integrity';
      default: return 'Dashboard';
    }
  };

  const headerContent = (
    <header className="fixed top-0 left-0 right-0 lg:left-64 flex items-center justify-between px-4 md:px-6 pt-[max(16px,env(safe-area-inset-top))] pb-4 bg-[#293515] shadow-md transition-all duration-200 text-[#F2F2EC] pointer-events-auto" style={{ zIndex: 'var(--z-header)' }}>
      <button 
        onClick={() => navigate('/')}
        className="flex items-center justify-center min-h-[44px] hover:opacity-70 transition-opacity py-1 flex-shrink-0 z-10"
        aria-label="Go to home"
      >
        <img 
          src="/assets/logos/mascot-white.webp" 
          alt="Ever House" 
          className="h-10 w-auto object-contain"
        />
      </button>
      
      <div className="absolute inset-0 flex items-center justify-center pt-[max(16px,env(safe-area-inset-top))] pb-4 pointer-events-none">
        <h1 className="text-lg font-bold text-[#F2F2EC] tracking-wide">
          {activeTab === 'home' ? 'Staff Portal' : getTabTitle()}
        </h1>
      </div>

      <div className="flex items-center gap-2 md:gap-3 flex-shrink-0 z-10">
        <button 
          onClick={() => handleTabChange('updates')}
          className="flex items-center justify-center min-w-[44px] min-h-[44px] hover:opacity-70 transition-opacity relative"
          aria-label="Updates"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[24px]">campaign</span>
          {unreadNotifCount > 0 && (
            <span className="absolute top-1 right-1 w-4 h-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
              {unreadNotifCount > 9 ? '9+' : unreadNotifCount}
            </span>
          )}
        </button>
        <button 
          onClick={() => navigate('/profile')}
          className="flex items-center justify-center min-w-[44px] min-h-[44px] hover:opacity-70 transition-opacity rounded-full"
          aria-label="View profile"
        >
          <Avatar name={actualUser?.name} email={actualUser?.email} size="md" />
        </button>
      </div>
    </header>
  );

  return (
    <div className="min-h-screen bg-bone font-display dark:bg-transparent transition-colors duration-300 flex flex-col relative">
      
      <StaffSidebar 
        activeTab={activeTab} 
        onTabChange={handleTabChange} 
        isAdmin={actualUser?.role === 'admin'} 
      />
      
      {createPortal(headerContent, document.body)}

      <main className={`flex-1 px-4 md:px-8 mx-auto pt-[max(112px,calc(env(safe-area-inset-top)+96px))] w-full relative z-0 lg:ml-64 ${activeTab === 'simulator' || activeTab === 'home' || activeTab === 'directory' ? 'max-w-[1920px]' : 'max-w-4xl'}`}>
        {activeTab === 'home' && <StaffCommandCenter onTabChange={handleTabChange} isAdmin={actualUser?.role === 'admin'} wsConnected={staffWsConnected} />}
        {activeTab === 'training' && <StaffTrainingGuide />}
        <PageErrorBoundary pageName={`Admin Tab: ${activeTab}`}>
          <Suspense fallback={<TabLoadingFallback />}>
            {activeTab === 'cafe' && <CafeTab />}
            {activeTab === 'events' && <EventsTab />}
            {activeTab === 'announcements' && <AnnouncementsTab />}
            {activeTab === 'directory' && <DirectoryTab />}
            {activeTab === 'simulator' && <SimulatorTab onTabChange={handleTabChange} />}
            {activeTab === 'team' && <TeamTab />}
            {activeTab === 'faqs' && <FaqsAdmin />}
            {activeTab === 'inquiries' && <InquiriesAdmin />}
            {activeTab === 'gallery' && <GalleryAdmin />}
            {activeTab === 'tiers' && actualUser?.role === 'admin' && <TiersTab />}
            {activeTab === 'blocks' && <BlocksTab />}
            {activeTab === 'changelog' && <ChangelogTab />}
            {activeTab === 'bugs' && actualUser?.role === 'admin' && <BugReportsAdmin />}
            {activeTab === 'updates' && <UpdatesTab />}
            {activeTab === 'tours' && <ToursTab />}
            {activeTab === 'trackman' && actualUser?.role === 'admin' && <TrackmanTab />}
            {activeTab === 'data-integrity' && actualUser?.role === 'admin' && <DataIntegrityTab />}
          </Suspense>
        </PageErrorBoundary>
        <BottomSentinel />
      </main>

      <div className="lg:hidden">
        <StaffBottomNav 
          activeTab={activeTab} 
          onTabChange={handleTabChange} 
          isAdmin={actualUser?.role === 'admin'}
          pendingRequestsCount={pendingRequestsCount}
        />
      </div>

      <BackToTop threshold={200} />

      <MenuOverlay isOpen={isMenuOpen} onClose={() => setIsMenuOpen(false)} />
    </div>
  );
};

interface TrainingSectionDB {
    id: number;
    icon: string;
    title: string;
    description: string;
    steps: { title: string; content: string; imageUrl?: string; pageIcon?: string }[];
    isAdminOnly: boolean;
    sortOrder: number;
}

interface TrainingModalProps {
    isOpen: boolean;
    onClose: () => void;
    section: TrainingSectionDB | null;
    onSave: (section: Partial<TrainingSectionDB>) => Promise<void>;
}

const COMMON_ICONS = [
    'login', 'event_note', 'event', 'spa', 'campaign', 'groups', 'local_cafe',
    'mail', 'photo_library', 'help_outline', 'block', 'shield_person', 'loyalty',
    'visibility', 'settings', 'dashboard', 'person', 'notifications', 'bookmark',
    'star', 'favorite', 'check_circle', 'info', 'warning', 'error', 'lightbulb',
    'edit', 'delete', 'add', 'remove', 'search', 'home', 'menu', 'close'
];

const TrainingSectionModal: React.FC<TrainingModalProps> = ({ isOpen, onClose, section, onSave }) => {
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [icon, setIcon] = useState('help_outline');
    const [isAdminOnly, setIsAdminOnly] = useState(false);
    const [steps, setSteps] = useState<{ title: string; content: string; imageUrl?: string; pageIcon?: string }[]>([{ title: '', content: '' }]);
    const [saving, setSaving] = useState(false);
    const [showIconPicker, setShowIconPicker] = useState(false);

    useEffect(() => {
        if (section) {
            setTitle(section.title);
            setDescription(section.description);
            setIcon(section.icon);
            setIsAdminOnly(section.isAdminOnly);
            setSteps(section.steps.length > 0 ? section.steps : [{ title: '', content: '' }]);
        } else {
            setTitle('');
            setDescription('');
            setIcon('help_outline');
            setIsAdminOnly(false);
            setSteps([{ title: '', content: '' }]);
        }
    }, [section, isOpen]);

    const handleAddStep = () => {
        setSteps([...steps, { title: '', content: '' }]);
    };

    const handleRemoveStep = (index: number) => {
        if (steps.length > 1) {
            setSteps(steps.filter((_, i) => i !== index));
        }
    };

    const handleStepChange = (index: number, field: 'title' | 'content' | 'imageUrl' | 'pageIcon', value: string) => {
        const updated = [...steps];
        updated[index] = { ...updated[index], [field]: value };
        setSteps(updated);
    };

    const handleSave = async () => {
        if (!title.trim() || !description.trim()) return;
        setSaving(true);
        try {
            await onSave({
                id: section?.id,
                title: title.trim(),
                description: description.trim(),
                icon,
                isAdminOnly,
                steps: steps.filter(s => s.title.trim() && s.content.trim())
            });
            onClose();
        } catch (err) {
            console.error('Failed to save section:', err);
        } finally {
            setSaving(false);
        }
    };

    return (
        <ModalShell isOpen={isOpen} onClose={onClose} title={section ? 'Edit Training Section' : 'Add Training Section'} showCloseButton={true}>
            <div className="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
                <div>
                    <label className="block text-sm font-medium text-primary dark:text-white mb-1">Title</label>
                    <input
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        className="w-full px-4 py-2.5 rounded-xl border border-primary/20 dark:border-white/25 bg-white/60 dark:bg-white/5 text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
                        placeholder="Section title"
                    />
                </div>

                <div>
                    <label className="block text-sm font-medium text-primary dark:text-white mb-1">Description</label>
                    <input
                        type="text"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        className="w-full px-4 py-2.5 rounded-xl border border-primary/20 dark:border-white/25 bg-white/60 dark:bg-white/5 text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
                        placeholder="Brief description"
                    />
                </div>

                <div>
                    <label className="block text-sm font-medium text-primary dark:text-white mb-1">Icon</label>
                    <div className="relative">
                        <button
                            type="button"
                            onClick={() => setShowIconPicker(!showIconPicker)}
                            className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-primary/20 dark:border-white/25 bg-white/60 dark:bg-white/5 text-primary dark:text-white"
                        >
                            <span aria-hidden="true" className="material-symbols-outlined">{icon}</span>
                            <span className="text-sm">{icon}</span>
                        </button>
                        {showIconPicker && (
                            <div className="absolute top-full left-0 mt-2 p-3 bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-primary/20 dark:border-white/25 grid grid-cols-6 gap-2 z-10 max-w-xs">
                                {COMMON_ICONS.map(ic => (
                                    <button
                                        key={ic}
                                        type="button"
                                        onClick={() => { setIcon(ic); setShowIconPicker(false); }}
                                        className={`p-2 rounded-lg hover:bg-primary/10 dark:hover:bg-white/10 ${icon === ic ? 'bg-primary/20 dark:bg-white/20' : ''}`}
                                    >
                                        <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">{ic}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <Toggle checked={isAdminOnly} onChange={setIsAdminOnly} size="sm" />
                    <span className="text-sm text-primary dark:text-white">Admin Only</span>
                </div>

                <div>
                    <label className="block text-sm font-medium text-primary dark:text-white mb-2">Steps</label>
                    <div className="space-y-3">
                        {steps.map((step, index) => (
                            <div key={index} className="p-4 bg-primary/5 dark:bg-white/5 rounded-xl space-y-3">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm font-medium text-primary dark:text-white">Step {index + 1}</span>
                                    {steps.length > 1 && (
                                        <button
                                            type="button"
                                            onClick={() => handleRemoveStep(index)}
                                            className="p-1 text-red-500 hover:bg-red-500/10 rounded-full"
                                        >
                                            <span aria-hidden="true" className="material-symbols-outlined text-sm">close</span>
                                        </button>
                                    )}
                                </div>
                                <input
                                    type="text"
                                    value={step.title}
                                    onChange={(e) => handleStepChange(index, 'title', e.target.value)}
                                    className="w-full px-3 py-2 rounded-lg border border-primary/20 dark:border-white/25 bg-white/60 dark:bg-white/5 text-primary dark:text-white text-sm"
                                    placeholder="Step title"
                                />
                                <textarea
                                    value={step.content}
                                    onChange={(e) => handleStepChange(index, 'content', e.target.value)}
                                    className="w-full px-3 py-2 rounded-lg border border-primary/20 dark:border-white/25 bg-white/60 dark:bg-white/5 text-primary dark:text-white text-sm resize-none"
                                    rows={3}
                                    placeholder="Step content"
                                />
                            </div>
                        ))}
                        <button
                            type="button"
                            onClick={handleAddStep}
                            className="mt-4 flex items-center gap-2 px-4 py-2 rounded-full border border-dashed border-primary/30 dark:border-white/30 text-primary dark:text-white hover:bg-primary/5 dark:hover:bg-white/5 transition-colors text-sm"
                        >
                            <span aria-hidden="true" className="material-symbols-outlined text-lg">add</span>
                            Add Step
                        </button>
                    </div>
                </div>

                <div className="flex gap-3 justify-end pt-4 border-t border-primary/10 dark:border-white/25">
                    <button onClick={onClose} className="px-5 py-2.5 rounded-full text-primary dark:text-white hover:bg-primary/10 dark:hover:bg-white/10">
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving || !title.trim() || !description.trim() || steps.every(s => !s.title.trim() || !s.content.trim())}
                        className="px-5 py-2.5 rounded-full bg-primary dark:bg-accent text-white dark:text-primary font-medium disabled:opacity-50"
                    >
                        {saving ? 'Saving...' : 'Save Section'}
                    </button>
                </div>
            </div>
        </ModalShell>
    );
};

const StaffTrainingGuide: React.FC = () => {
    const [expandedSection, setExpandedSection] = useState<string | null>(null);
    const [sections, setSections] = useState<TrainingSectionDB[]>([]);
    const [loading, setLoading] = useState(true);
    const [authError, setAuthError] = useState(false);
    const [modalOpen, setModalOpen] = useState(false);
    const [editingSection, setEditingSection] = useState<TrainingSectionDB | null>(null);
    const { actualUser } = useData();
    const isAdmin = actualUser?.role === 'admin';
    const printRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        fetchSections();
    }, []);

    const fetchSections = async () => {
        try {
            const response = await fetch('/api/training-sections', { credentials: 'include' });
            if (response.ok) {
                const data = await response.json();
                setSections(data);
                setAuthError(false);
            } else if (response.status === 401) {
                setAuthError(true);
            }
        } catch (error) {
            console.error('Failed to fetch training sections:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async (sectionData: Partial<TrainingSectionDB>) => {
        const isEdit = !!sectionData.id;
        const url = isEdit ? `/api/admin/training-sections/${sectionData.id}` : '/api/admin/training-sections';
        const method = isEdit ? 'PUT' : 'POST';

        const response = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(sectionData)
        });

        if (!response.ok) throw new Error('Save failed');
        await fetchSections();
    };

    const handleDelete = async (id: number) => {
        if (!confirm('Are you sure you want to delete this training section?')) return;
        try {
            const response = await fetch(`/api/admin/training-sections/${id}`, {
                method: 'DELETE',
                credentials: 'include'
            });
            if (response.ok) {
                await fetchSections();
            }
        } catch (error) {
            console.error('Delete failed:', error);
        }
    };

    const [isPrinting, setIsPrinting] = useState(false);

    const openAddModal = () => {
        setEditingSection(null);
        setModalOpen(true);
    };

    const openEditModal = (section: TrainingSectionDB) => {
        setEditingSection(section);
        setModalOpen(true);
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin"></div>
            </div>
        );
    }

    if (authError) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center">
                <span aria-hidden="true" className="material-symbols-outlined text-5xl text-primary/70 dark:text-white/70 mb-4">lock</span>
                <h3 className="text-lg font-bold text-primary dark:text-white mb-2">Session Expired</h3>
                <p className="text-sm text-primary/80 dark:text-white/80 mb-6 max-w-sm">
                    Your session has expired. Please refresh the page or log in again to view the training guide.
                </p>
                <button
                    onClick={() => window.location.reload()}
                    className="px-5 py-2.5 bg-primary dark:bg-accent text-white dark:text-primary rounded-full font-medium"
                >
                    Refresh Page
                </button>
            </div>
        );
    }

    return (
        <div className="space-y-6 animate-pop-in pb-32">
            <div className="mb-6">
                <p className="text-sm text-primary/80 dark:text-white/80 mb-4">
                    A complete guide to using the Ever House Staff Portal. Tap any section to expand and view detailed instructions.
                </p>
                {isAdmin && (
                    <div className="flex gap-2 print:hidden">
                        <button
                            onClick={openAddModal}
                            className="flex items-center gap-2 px-4 py-2.5 bg-accent text-primary rounded-full text-sm font-medium hover:opacity-90 transition-opacity"
                        >
                            <span aria-hidden="true" className="material-symbols-outlined text-lg">add</span>
                            Add Section
                        </button>
                    </div>
                )}
            </div>

            <div ref={printRef} className="space-y-4 print:space-y-6">
                <div className="hidden print:block text-center mb-8">
                    <h1 className="text-2xl font-bold text-primary">Ever House Staff Training Guide</h1>
                    <p className="text-sm text-gray-500 mt-2">Comprehensive instructions for using the Staff Portal</p>
                </div>

                {sections.map((section) => (
                    <div 
                        key={section.id}
                        className="group bg-white/60 dark:bg-white/5 backdrop-blur-sm rounded-2xl border border-primary/10 dark:border-white/25 overflow-hidden print:border print:border-gray-200 print:break-inside-avoid hover:bg-white/80 dark:hover:bg-white/10 transition-colors cursor-pointer"
                        onClick={() => setExpandedSection(expandedSection === String(section.id) ? null : String(section.id))}
                    >
                        <div className="flex items-center">
                            <div
                                className="flex-1 flex items-center gap-4 p-5 text-left print:hover:bg-transparent"
                            >
                                <div className="w-12 h-12 rounded-xl bg-primary/10 dark:bg-white/10 flex items-center justify-center flex-shrink-0 print:bg-gray-100">
                                    <span aria-hidden="true" className="material-symbols-outlined text-2xl text-primary dark:text-white print:text-gray-700">{section.icon}</span>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <h3 className="font-bold text-primary dark:text-white print:text-gray-900">{section.title}</h3>
                                    <p className="text-sm text-primary/80 dark:text-white/80 print:text-gray-500">{section.description}</p>
                                </div>
                                <span className={`material-symbols-outlined text-primary/70 dark:text-white/70 transition-transform duration-300 print:hidden ${expandedSection === String(section.id) ? 'rotate-180' : ''}`}>
                                    expand_more
                                </span>
                            </div>
                            {isAdmin && (
                                <div className="flex gap-1 pr-4 print:hidden" onClick={(e) => e.stopPropagation()}>
                                    <button onClick={() => openEditModal(section)} className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full">
                                        <span aria-hidden="true" className="material-symbols-outlined text-primary/80 dark:text-white/80">edit</span>
                                    </button>
                                    <button onClick={() => handleDelete(section.id)} className="p-2 hover:bg-red-500/10 rounded-full">
                                        <span aria-hidden="true" className="material-symbols-outlined text-red-500/60">delete</span>
                                    </button>
                                </div>
                            )}
                        </div>

                        <div className={`overflow-hidden transition-all duration-300 ${isPrinting || expandedSection === String(section.id) ? 'max-h-[5000px]' : 'max-h-0'}`}>
                            <div className="px-5 pb-5 space-y-4 print:pt-2">
                                {section.steps.map((step, index) => (
                                    <div key={index} className="flex gap-4">
                                        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 dark:bg-white/10 flex items-center justify-center text-sm font-bold text-primary dark:text-white print:bg-gray-100 print:text-gray-700">
                                            {index + 1}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <h4 className="font-semibold text-primary dark:text-white text-sm print:text-gray-900">{step.title}</h4>
                                                {step.pageIcon && (
                                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/20 dark:bg-accent/30 text-xs text-primary dark:text-accent print:bg-gray-200 print:text-gray-700">
                                                        <span aria-hidden="true" className="material-symbols-outlined text-xs">{step.pageIcon}</span>
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-sm text-primary/70 dark:text-white/70 mt-1 print:text-gray-600">{step.content}</p>
                                            {step.imageUrl && (
                                                <img src={step.imageUrl} alt="" className="mt-2 rounded-lg max-w-full h-auto print:max-w-xs" />
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                ))}

                <div className="hidden print:block mt-8 pt-4 border-t border-gray-200 text-center text-xs text-gray-600">
                    <p>Ever House Members App - Staff Training Guide</p>
                    <p>Generated on {new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Los_Angeles' })}</p>
                </div>
            </div>

            <TrainingSectionModal
                isOpen={modalOpen}
                onClose={() => setModalOpen(false)}
                section={editingSection}
                onSave={handleSave}
            />
        </div>
    );
};

export default AdminDashboard;

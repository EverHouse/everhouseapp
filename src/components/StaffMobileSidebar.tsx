import React, { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import { useNavigationLoading } from '../contexts/NavigationLoadingContext';
import { getLatestVersion } from '../data/changelog-version';
import { TabType, tabToPath } from '../pages/Admin/layout/types';
import { prefetchStaffRoute, prefetchAdjacentStaffRoutes } from '../lib/prefetch';
import BugReportModal from './BugReportModal';

interface NavItem {
  id: TabType;
  icon: string;
  label: string;
}

interface StaffMobileSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  activeTab: TabType;
  isAdmin?: boolean;
}

const MAIN_NAV_ITEMS: NavItem[] = [
  { id: 'home', icon: 'dashboard', label: 'Dashboard' },
  { id: 'simulator', icon: 'event_note', label: 'Bookings' },
  { id: 'financials', icon: 'point_of_sale', label: 'Financials' },
  { id: 'tours', icon: 'directions_walk', label: 'Tours' },
  { id: 'events', icon: 'calendar_month', label: 'Calendar' },
  { id: 'blocks', icon: 'domain', label: 'Facility' },
  { id: 'updates', icon: 'campaign', label: 'Updates' },
  { id: 'directory', icon: 'group', label: 'Directory' },
  { id: 'training', icon: 'school', label: 'Training Guide' },
];

const ADMIN_ITEMS: NavItem[] = [
  { id: 'tiers', icon: 'storefront', label: 'Products & Pricing' },
  { id: 'team', icon: 'badge', label: 'Manage Team' },
  { id: 'gallery', icon: 'photo_library', label: 'Gallery' },
  { id: 'faqs', icon: 'help_outline', label: 'FAQs' },
  { id: 'inquiries', icon: 'mail', label: 'Inquiries' },
  { id: 'applications', icon: 'how_to_reg', label: 'Applications' },
  { id: 'bugs', icon: 'bug_report', label: 'Bug Reports' },
  { id: 'email-templates', icon: 'forward_to_inbox', label: 'Email Templates' },
  { id: 'changelog', icon: 'history', label: 'Changelog' },
  { id: 'data-integrity', icon: 'fact_check', label: 'Data Integrity' },
  { id: 'settings', icon: 'settings', label: 'Settings' },
];

export const StaffMobileSidebar: React.FC<StaffMobileSidebarProps> = ({
  isOpen,
  onClose,
  activeTab,
  isAdmin = false,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { startNavigation } = useNavigationLoading();
  const [showBugReport, setShowBugReport] = useState(false);
  const [optimisticTab, setOptimisticTab] = useState<TabType | null>(null);

  useEffect(() => {
    prefetchAdjacentStaffRoutes(location.pathname);
  }, [location.pathname]);

  useEffect(() => {
    if (optimisticTab && activeTab === optimisticTab) {
      setOptimisticTab(null);
    }
  }, [activeTab, optimisticTab]);

  const displayActiveTab = optimisticTab || activeTab;

  const navigateToTab = useCallback((tab: TabType) => {
    if (tab === activeTab) return;
    if (tabToPath[tab]) {
      startNavigation();
      setOptimisticTab(tab);
      navigate(tabToPath[tab]);
    }
  }, [navigate, startNavigation, activeTab]);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  const handleNavClick = (tab: TabType) => {
    navigateToTab(tab);
    onClose();
  };

  const handleHomeClick = () => {
    startNavigation();
    navigate('/');
    onClose();
  };

  const NavButton: React.FC<{ item: NavItem }> = ({ item }) => {
    const isActive = displayActiveTab === item.id;
    return (
      <button
        onClick={() => handleNavClick(item.id)}
        onMouseEnter={() => prefetchStaffRoute(tabToPath[item.id])}
        style={{ WebkitTapHighlightColor: 'transparent', fontFamily: 'var(--font-label)' }}
        className={`
          tactile-row w-full flex items-center gap-3 px-3 py-3 text-left transition-all duration-fast
          ${isActive 
            ? 'text-white font-semibold border-l-2 border-[#CCB8E4]' 
            : 'text-white/50 hover:text-white/80 border-l-2 border-transparent'
          }
        `}
      >
        <span className={`material-symbols-outlined text-[18px] transition-colors duration-normal ${isActive ? 'filled text-[#CCB8E4]' : ''}`}>
          {item.icon}
        </span>
        <span className="text-[11px] uppercase tracking-[0.2em] translate-y-[1px]">{item.label}</span>
      </button>
    );
  };

  if (!isOpen) return null;

  const sidebarContent = (
    <div className="fixed inset-0" style={{ zIndex: 'var(--z-modal, 100)' }}>
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      
      <aside 
        className="absolute left-0 top-0 bottom-0 w-72 bg-[#293515] shadow-2xl flex flex-col animate-slide-in-left"
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <button 
          onClick={handleHomeClick}
          className="flex items-center gap-3 px-4 py-5 flex-shrink-0 hover:opacity-80 transition-opacity w-full text-left border-b border-white/10"
          aria-label="Go to home"
        >
          <img 
            src="/assets/logos/mascot-white.webp" 
            alt="Ever Club logo" 
            className="h-10 w-auto object-contain"
          />
          <div>
            <h1 className="text-white font-bold text-lg leading-tight" style={{ fontFamily: 'var(--font-body)' }}>Staff Portal</h1>
            <p className="text-white/50 text-xs" style={{ fontFamily: 'var(--font-body)' }}>Ever Club</p>
          </div>
        </button>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <div className="space-y-0.5">
            {MAIN_NAV_ITEMS.map(item => (
              <NavButton key={item.id} item={item} />
            ))}
          </div>

          {isAdmin && (
            <div className="mt-6 pt-4 border-t border-white/10">
              <p className="px-3 mb-2 text-[10px] font-semibold text-white/30 uppercase tracking-[0.2em]" style={{ fontFamily: 'var(--font-label)' }}>
                Admin
              </p>
              <div className="space-y-0.5">
                {ADMIN_ITEMS.map(item => (
                  <NavButton key={item.id} item={item} />
                ))}
              </div>
            </div>
          )}
        </nav>

        <div className="px-3 py-4 border-t border-white/10 flex-shrink-0 space-y-3" style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>
          <button
            onClick={() => setShowBugReport(true)}
            style={{ fontFamily: 'var(--font-label)' }}
            className="tactile-row w-full flex items-center gap-3 px-3 py-3 text-left transition-all duration-fast text-white/50 hover:text-white/80 border-l-2 border-transparent"
          >
            <span className="material-symbols-outlined text-[18px]">bug_report</span>
            <span className="text-[11px] uppercase tracking-[0.2em] translate-y-[1px]">Report a Bug</span>
          </button>
          <p className="text-white/40 text-[10px] text-center">
            v{getLatestVersion().version} · Updated {new Date(getLatestVersion().date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' })}
          </p>
        </div>
      </aside>
    </div>
  );

  return (
    <>
      {createPortal(sidebarContent, document.body)}
      <BugReportModal
        isOpen={showBugReport}
        onClose={() => setShowBugReport(false)}
      />
    </>
  );
};

export default StaffMobileSidebar;

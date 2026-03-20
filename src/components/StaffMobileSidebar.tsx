import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import { useNavigationLoading } from '../stores/navigationLoadingStore';
import { useScrollLockManager } from '../hooks/useScrollLockManager';
import { getLatestVersion } from '../data/changelog-version';
import { TabType, tabToPath } from '../lib/nav-constants';
import { MAIN_NAV_ITEMS, ADMIN_NAV_ITEMS } from '../pages/Admin/layout/types';
import { prefetchStaffRoute, prefetchAdjacentStaffRoutes } from '../lib/prefetch-actions';
import BugReportModal from './BugReportModal';
import Icon from './icons/Icon';

interface StaffMobileSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  activeTab: TabType | null;
  isAdmin?: boolean;
}

const EXIT_DURATION = 250;

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
  const [isClosing, setIsClosing] = useState(false);
  const [rendered, setRendered] = useState(false);
  const closingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (closingTimer.current) {
      clearTimeout(closingTimer.current);
      closingTimer.current = null;
    }

    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRendered(true);
      setIsClosing(false);
    } else if (rendered) {
      setIsClosing(true);
      closingTimer.current = setTimeout(() => {
        setRendered(false);
        setIsClosing(false);
        closingTimer.current = null;
      }, EXIT_DURATION);
    }

    return () => {
      if (closingTimer.current) {
        clearTimeout(closingTimer.current);
        closingTimer.current = null;
      }
    };
  }, [isOpen, rendered]);

  useEffect(() => {
    prefetchAdjacentStaffRoutes(location.pathname);
  }, [location.pathname]);

  useEffect(() => {
    if (optimisticTab && activeTab === optimisticTab) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOptimisticTab(null);
    }
  }, [activeTab, optimisticTab]);

  const displayActiveTab = optimisticTab || activeTab;

  const navigateToTab = useCallback((tab: TabType) => {
    if (activeTab !== null && tab === activeTab) return;
    if (tabToPath[tab]) {
      startNavigation();
      setOptimisticTab(tab);
      navigate(tabToPath[tab]);
    }
  }, [navigate, startNavigation, activeTab]);

  useScrollLockManager(isOpen);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleNavClick = (tab: TabType) => {
    navigateToTab(tab);
    handleClose();
  };

  const handleHomeClick = () => {
    startNavigation();
    navigate('/');
    handleClose();
  };

  const NavButton: React.FC<{ item: typeof MAIN_NAV_ITEMS[number] }> = ({ item }) => {
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
        <Icon name={item.icon} className={`text-[18px] transition-colors duration-normal ${isActive ? 'filled text-[#CCB8E4]' : ''}`} />
        <span className="text-[11px] uppercase tracking-[0.2em] translate-y-[1px]">{item.label}</span>
      </button>
    );
  };

  if (!rendered) return null;

  const sidebarContent = (
    <div className="fixed inset-0" style={{ zIndex: 'var(--z-modal, 100)' }}>
      <div 
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-normal ${
          isClosing ? 'opacity-0' : 'opacity-100 animate-backdrop-fade-in'
        }`}
        onClick={handleClose}
      />
      
      <aside 
        className={`absolute left-0 top-0 bottom-0 w-72 bg-[#293515] shadow-2xl flex flex-col ${
          isClosing ? 'animate-slide-out-left' : 'animate-slide-in-left'
        }`}
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <button 
          onClick={handleHomeClick}
          className="flex items-center gap-3 px-6 py-6 flex-shrink-0 hover:opacity-80 transition-opacity w-full text-left border-b border-white/10"
          aria-label="Go to home"
        >
          <img 
            src="/assets/logos/mascot-white.webp" 
            alt="Ever Club logo" 
            className="h-8 w-auto object-contain"
          />
          <div>
            <h1 className="text-[10px] text-white/40 uppercase tracking-[0.4em] leading-none" style={{ fontFamily: 'var(--font-label)' }}>Staff Portal</h1>
            <p className="text-[9px] text-white/25 uppercase tracking-[0.3em] mt-1.5" style={{ fontFamily: 'var(--font-label)' }}>Ever Club</p>
          </div>
        </button>

        <nav className="flex-1 overflow-y-auto px-3 py-4" data-scroll-lock-allow>
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
                {ADMIN_NAV_ITEMS.map(item => (
                  <NavButton key={item.id} item={item} />
                ))}
              </div>
            </div>
          )}
        </nav>

        <div className="px-3 py-4 border-t border-white/10 flex-shrink-0 space-y-3" style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>
          <button
            onClick={() => { startNavigation(); navigate('/kiosk'); handleClose(); }}
            style={{ WebkitTapHighlightColor: 'transparent', fontFamily: 'var(--font-label)' }}
            className="tactile-row w-full flex items-center gap-3 px-3 py-3 text-left transition-all duration-fast text-white/50 hover:text-white/80 border-l-2 border-transparent"
          >
            <Icon name="qr_code_scanner" className="text-[18px]" />
            <span className="text-[11px] uppercase tracking-[0.2em] translate-y-[1px]">Kiosk Check-in</span>
          </button>
          <button
            onClick={() => setShowBugReport(true)}
            style={{ fontFamily: 'var(--font-label)' }}
            className="tactile-row w-full flex items-center gap-3 px-3 py-3 text-left transition-all duration-fast text-white/50 hover:text-white/80 border-l-2 border-transparent"
          >
            <Icon name="bug_report" className="text-[18px]" />
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

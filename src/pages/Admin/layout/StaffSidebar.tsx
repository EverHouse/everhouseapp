import React from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { TabType } from './types';
import { useNavigationLoading } from '../../../contexts/NavigationLoadingContext';

interface NavItem {
  id: TabType;
  icon: string;
  label: string;
}

interface StaffSidebarProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
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
];

const RESOURCES_ITEMS: NavItem[] = [
  { id: 'cafe', icon: 'local_cafe', label: 'Cafe Menu' },
  { id: 'training', icon: 'school', label: 'Training Guide' },
  { id: 'team', icon: 'badge', label: 'Team' },
];

const ADMIN_ITEMS: NavItem[] = [
  { id: 'tiers', icon: 'settings', label: 'Membership Config' },
  { id: 'gallery', icon: 'photo_library', label: 'Gallery' },
  { id: 'faqs', icon: 'help_outline', label: 'FAQs' },
  { id: 'inquiries', icon: 'mail', label: 'Inquiries' },
  { id: 'bugs', icon: 'bug_report', label: 'Bug Reports' },
  { id: 'changelog', icon: 'history', label: 'Changelog' },
  { id: 'data-integrity', icon: 'fact_check', label: 'Data Integrity' },
  { id: 'staff-activity', icon: 'manage_history', label: 'Staff Activity' },
];

export const StaffSidebar: React.FC<StaffSidebarProps> = ({ 
  activeTab, 
  onTabChange,
  isAdmin = false 
}) => {
  const navigate = useNavigate();
  const { startNavigation } = useNavigationLoading();
  
  const NavButton: React.FC<{ item: NavItem }> = ({ item }) => {
    const isActive = activeTab === item.id;
    return (
      <button
        onClick={() => onTabChange(item.id)}
        className={`
          w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all duration-200
          ${isActive 
            ? 'bg-white/20 text-white font-semibold shadow-sm' 
            : 'text-white/70 hover:bg-white/10 hover:text-white'
          }
        `}
      >
        <span className={`material-symbols-outlined text-xl ${isActive ? 'filled' : ''}`}>
          {item.icon}
        </span>
        <span className="text-sm">{item.label}</span>
      </button>
    );
  };

  const sidebarContent = (
    <aside className="hidden lg:flex flex-col w-64 h-screen fixed left-0 top-0 bg-[#293515]" style={{ zIndex: 'var(--z-sidebar, 40)' }}>
      <button 
        onClick={() => { startNavigation(); navigate('/'); }}
        className="flex items-center gap-3 px-4 py-5 flex-shrink-0 hover:opacity-80 transition-opacity w-full text-left"
        aria-label="Go to home"
      >
        <img 
          src="/assets/logos/mascot-white.webp" 
          alt="Ever House" 
          className="h-10 w-auto object-contain"
        />
        <div>
          <h1 className="text-white font-bold text-lg leading-tight">Staff Portal</h1>
          <p className="text-white/50 text-xs">Ever House</p>
        </div>
      </button>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <div className="space-y-1">
          {MAIN_NAV_ITEMS.map(item => (
            <NavButton key={item.id} item={item} />
          ))}
        </div>

        <div className="mt-6 pt-4 border-t border-white/10">
          <p className="px-3 mb-2 text-[10px] font-semibold text-white/40 uppercase tracking-wider">
            Resources
          </p>
          <div className="space-y-1">
            {RESOURCES_ITEMS.map(item => (
              <NavButton key={item.id} item={item} />
            ))}
          </div>
        </div>

        {isAdmin && (
          <div className="mt-6 pt-4 border-t border-white/10">
            <p className="px-3 mb-2 text-[10px] font-semibold text-white/40 uppercase tracking-wider">
              Admin
            </p>
            <div className="space-y-1">
              {ADMIN_ITEMS.map(item => (
                <NavButton key={item.id} item={item} />
              ))}
            </div>
          </div>
        )}
      </nav>

      <div className="px-3 py-4 border-t border-white/10 flex-shrink-0">
        <p className="text-white/40 text-[10px] text-center">
          v2.0 Navigation
        </p>
      </div>
    </aside>
  );

  return createPortal(sidebarContent, document.body);
};

export default StaffSidebar;

import React, { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TabType, QuickLink } from '../types';
import { EMPLOYEE_RESOURCES_LINKS, ADMIN_LINKS, ADMIN_ROUTE_LINKS } from '../helpers';
import { useNavigationLoading } from '../../../contexts/NavigationLoadingContext';
import { tabToPath } from '../../../pages/Admin/layout/types';

interface QuickActionsGridProps {
  isAdmin?: boolean;
  variant: 'desktop' | 'mobile';
  onNewMember?: () => void;
  onScanQr?: () => void;
}

export const QuickActionsGrid: React.FC<QuickActionsGridProps> = ({ isAdmin, variant, onNewMember, onScanQr }) => {
  const navigate = useNavigate();
  const { startNavigation } = useNavigationLoading();
  const navigateToTab = useCallback((tab: TabType) => {
    if (tabToPath[tab]) navigate(tabToPath[tab]);
  }, [navigate]);

  if (variant === 'desktop') {
    return (
      <div className="flex-1 h-full bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-xl p-4 shadow-liquid dark:shadow-liquid-dark flex flex-col">
        <h3 className="font-bold text-primary dark:text-white mb-4" style={{ fontFamily: 'var(--font-headline)' }}>Employee Resources</h3>
        
        <div className="flex-1 flex flex-col justify-between">
          <div>
            <p className="text-xs text-primary/80 dark:text-white/80 uppercase tracking-widest mb-2">Quick Links</p>
            <div className="grid grid-cols-2 gap-2">
              {onScanQr && (
                <button
                  onClick={onScanQr}
                  className="flex flex-col items-center p-3 bg-green-500/20 dark:bg-green-500/30 rounded-xl hover:bg-green-500/30 dark:hover:bg-green-500/40 transition-colors tactile-btn"
                >
                  <span className="material-symbols-outlined text-2xl text-primary dark:text-white mb-1">qr_code_scanner</span>
                  <span className="text-xs text-primary dark:text-white font-medium text-center">Scan QR</span>
                </button>
              )}
              {EMPLOYEE_RESOURCES_LINKS.map(link => (
                <button
                  key={link.id}
                  onClick={() => navigateToTab(link.id)}
                  className="flex flex-col items-center p-3 bg-[#CCB8E4]/30 dark:bg-[#CCB8E4]/20 rounded-xl hover:bg-[#CCB8E4]/50 dark:hover:bg-[#CCB8E4]/30 transition-colors tactile-btn"
                >
                  <span className="material-symbols-outlined text-2xl text-primary dark:text-white mb-1">{link.icon}</span>
                  <span className="text-xs text-primary dark:text-white font-medium text-center">{link.label}</span>
                </button>
              ))}
            </div>
          </div>
          
          {isAdmin && (
            <div className="pt-4 border-t border-primary/10 dark:border-white/10">
              <p className="text-xs text-primary/80 dark:text-white/80 uppercase tracking-widest mb-2">Admin Settings</p>
              <div className="grid grid-cols-2 gap-2">
                {ADMIN_LINKS.map(link => (
                  <button
                    key={link.id}
                    onClick={() => navigateToTab(link.id)}
                    className="flex flex-col items-center p-3 bg-primary/5 dark:bg-white/5 rounded-xl hover:bg-primary/10 dark:hover:bg-white/10 transition-colors tactile-btn"
                  >
                    <span className="material-symbols-outlined text-2xl text-primary dark:text-white mb-1">{link.icon}</span>
                    <span className="text-xs text-primary dark:text-white font-medium text-center">{link.label}</span>
                  </button>
                ))}
                {ADMIN_ROUTE_LINKS.map(link => (
                  <button
                    key={link.route}
                    onClick={() => { startNavigation(); navigate(link.route); }}
                    className="flex flex-col items-center p-3 bg-primary/5 dark:bg-white/5 rounded-xl hover:bg-primary/10 dark:hover:bg-white/10 transition-colors tactile-btn"
                  >
                    <span className="material-symbols-outlined text-2xl text-primary dark:text-white mb-1">{link.icon}</span>
                    <span className="text-xs text-primary dark:text-white font-medium text-center">{link.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-xl p-4 shadow-liquid dark:shadow-liquid-dark">
      {onScanQr && (
        <div className="mb-4">
          <button
            onClick={onScanQr}
            className="w-full flex items-center justify-center gap-2 p-3 bg-green-500/20 dark:bg-green-500/30 rounded-xl hover:bg-green-500/30 transition-colors tactile-btn"
          >
            <span className="material-symbols-outlined text-xl text-primary dark:text-white">qr_code_scanner</span>
            <span className="text-sm text-primary dark:text-white font-medium">Scan QR Code</span>
          </button>
        </div>
      )}
      
      {isAdmin && (
        <div className={onScanQr ? "pt-4 border-t border-primary/10 dark:border-white/10" : ""}>
          <p className="text-xs text-primary/80 dark:text-white/80 uppercase tracking-widest mb-2">Admin Settings</p>
          <div className="grid grid-cols-3 gap-2">
            {ADMIN_LINKS.map(link => (
              <button
                key={link.id}
                onClick={() => navigateToTab(link.id)}
                className="flex flex-col items-center p-3 bg-primary/5 dark:bg-white/5 rounded-xl hover:bg-primary/10 transition-colors tactile-btn"
              >
                <span className="material-symbols-outlined text-xl text-primary dark:text-white mb-1">{link.icon}</span>
                <span className="text-[10px] text-primary dark:text-white font-medium text-center leading-tight">{link.label}</span>
              </button>
            ))}
            {ADMIN_ROUTE_LINKS.map(link => (
              <button
                key={link.route}
                onClick={() => { startNavigation(); navigate(link.route); }}
                className="flex flex-col items-center p-3 bg-primary/5 dark:bg-white/5 rounded-xl hover:bg-primary/10 transition-colors tactile-btn"
              >
                <span className="material-symbols-outlined text-xl text-primary dark:text-white mb-1">{link.icon}</span>
                <span className="text-[10px] text-primary dark:text-white font-medium text-center leading-tight">{link.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

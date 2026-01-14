import React from 'react';
import { useNavigate } from 'react-router-dom';
import type { TabType, QuickLink } from '../types';
import { EMPLOYEE_RESOURCES_LINKS, ADMIN_LINKS, ADMIN_ROUTE_LINKS } from '../helpers';

interface QuickActionsGridProps {
  onTabChange: (tab: TabType) => void;
  isAdmin?: boolean;
  variant: 'desktop' | 'mobile';
  onNewMember?: () => void;
}

export const QuickActionsGrid: React.FC<QuickActionsGridProps> = ({ onTabChange, isAdmin, variant, onNewMember }) => {
  const navigate = useNavigate();

  if (variant === 'desktop') {
    return (
      <div className="flex-1 h-full bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4 flex flex-col">
        <h3 className="font-bold text-primary dark:text-white mb-4">Employee Resources</h3>
        
        <div className="flex-1 flex flex-col justify-between">
          <div>
            <p className="text-xs text-primary/60 dark:text-white/60 uppercase tracking-wide mb-2">Quick Actions</p>
            <div className="grid grid-cols-2 gap-2 mb-4">
              {onNewMember && (
                <button
                  onClick={onNewMember}
                  className="flex flex-col items-center p-3 bg-green-100 dark:bg-green-900/30 rounded-xl hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors"
                >
                  <span className="material-symbols-outlined text-2xl text-green-700 dark:text-green-400 mb-1">person_add</span>
                  <span className="text-xs text-green-700 dark:text-green-400 font-medium text-center">New Member</span>
                </button>
              )}
            </div>
            <p className="text-xs text-primary/60 dark:text-white/60 uppercase tracking-wide mb-2">Quick Links</p>
            <div className="grid grid-cols-2 gap-2">
              {EMPLOYEE_RESOURCES_LINKS.map(link => (
                <button
                  key={link.id}
                  onClick={() => onTabChange(link.id)}
                  className="flex flex-col items-center p-3 bg-[#CCB8E4]/30 dark:bg-[#CCB8E4]/20 rounded-xl hover:bg-[#CCB8E4]/50 dark:hover:bg-[#CCB8E4]/30 transition-colors"
                >
                  <span className="material-symbols-outlined text-2xl text-primary dark:text-white mb-1">{link.icon}</span>
                  <span className="text-xs text-primary dark:text-white font-medium text-center">{link.label}</span>
                </button>
              ))}
            </div>
          </div>
          
          {isAdmin && (
            <div className="pt-4 border-t border-primary/10 dark:border-white/10">
              <p className="text-xs text-primary/60 dark:text-white/60 uppercase tracking-wide mb-2">Admin Settings</p>
              <div className="grid grid-cols-2 gap-2">
                {ADMIN_LINKS.map(link => (
                  <button
                    key={link.id}
                    onClick={() => onTabChange(link.id)}
                    className="flex flex-col items-center p-3 bg-primary/5 dark:bg-white/5 rounded-xl hover:bg-primary/10 dark:hover:bg-white/10 transition-colors"
                  >
                    <span className="material-symbols-outlined text-2xl text-primary dark:text-white mb-1">{link.icon}</span>
                    <span className="text-xs text-primary dark:text-white font-medium text-center">{link.label}</span>
                  </button>
                ))}
                {ADMIN_ROUTE_LINKS.map(link => (
                  <button
                    key={link.route}
                    onClick={() => navigate(link.route)}
                    className="flex flex-col items-center p-3 bg-primary/5 dark:bg-white/5 rounded-xl hover:bg-primary/10 dark:hover:bg-white/10 transition-colors"
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
    <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
      <h3 className="font-bold text-primary dark:text-white mb-4">Employee Resources</h3>
      
      <div className="mb-4">
        <p className="text-xs text-primary/60 dark:text-white/60 uppercase tracking-wide mb-2">Quick Actions</p>
        <div className="grid grid-cols-4 gap-2 mb-4">
          {onNewMember && (
            <button
              onClick={onNewMember}
              className="flex flex-col items-center p-3 bg-green-100 dark:bg-green-900/30 rounded-xl hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors"
            >
              <span className="material-symbols-outlined text-xl text-green-700 dark:text-green-400 mb-1">person_add</span>
              <span className="text-[10px] text-green-700 dark:text-green-400 font-medium text-center leading-tight">New Member</span>
            </button>
          )}
        </div>
        <p className="text-xs text-primary/60 dark:text-white/60 uppercase tracking-wide mb-2">Quick Links</p>
        <div className="grid grid-cols-4 gap-2">
          {EMPLOYEE_RESOURCES_LINKS.map(link => (
            <button
              key={link.id}
              onClick={() => onTabChange(link.id)}
              className="flex flex-col items-center p-3 bg-[#CCB8E4]/30 dark:bg-[#CCB8E4]/20 rounded-xl hover:bg-[#CCB8E4]/50 transition-colors"
            >
              <span className="material-symbols-outlined text-xl text-primary dark:text-white mb-1">{link.icon}</span>
              <span className="text-[10px] text-primary dark:text-white font-medium text-center leading-tight">{link.label}</span>
            </button>
          ))}
        </div>
      </div>
      
      {isAdmin && (
        <div className="pt-4 border-t border-primary/10 dark:border-white/10">
          <p className="text-xs text-primary/60 dark:text-white/60 uppercase tracking-wide mb-2">Admin Settings</p>
          <div className="grid grid-cols-3 gap-2">
            {ADMIN_LINKS.map(link => (
              <button
                key={link.id}
                onClick={() => onTabChange(link.id)}
                className="flex flex-col items-center p-3 bg-primary/5 dark:bg-white/5 rounded-xl hover:bg-primary/10 transition-colors"
              >
                <span className="material-symbols-outlined text-xl text-primary dark:text-white mb-1">{link.icon}</span>
                <span className="text-[10px] text-primary dark:text-white font-medium text-center leading-tight">{link.label}</span>
              </button>
            ))}
            {ADMIN_ROUTE_LINKS.map(link => (
              <button
                key={link.route}
                onClick={() => navigate(link.route)}
                className="flex flex-col items-center p-3 bg-primary/5 dark:bg-white/5 rounded-xl hover:bg-primary/10 transition-colors"
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

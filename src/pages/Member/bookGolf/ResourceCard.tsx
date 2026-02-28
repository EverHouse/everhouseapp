import React from 'react';
import type { Resource } from './bookGolfTypes';

interface ResourceCardProps {
  resource: Resource;
  selected: boolean;
  onClick: () => void;
  isDark?: boolean;
  requested?: boolean;
}

const ResourceCard: React.FC<ResourceCardProps> = ({ resource, selected, onClick, isDark = true, requested = false }) => {
  if (requested) {
    return (
      <div 
        className={`w-full flex items-center p-4 rounded-xl border opacity-60 cursor-not-allowed ${
          isDark ? 'bg-white/5 border-amber-500/30' : 'bg-amber-50 border-amber-200'
        }`}
      >
        <div className={`w-12 h-12 rounded-lg flex-shrink-0 flex items-center justify-center mr-4 overflow-hidden ${
          isDark ? 'bg-amber-500/10 text-amber-400' : 'bg-amber-100 text-amber-600'
        }`}>
          <span className="material-symbols-outlined text-2xl">pending</span>
        </div>
        
        <div className="flex-1">
          <div className="flex justify-between items-center mb-0.5">
            <span className={`font-bold text-base ${isDark ? 'text-white/60' : 'text-primary/60'}`}>{resource.name}</span>
            <span className={`w-fit text-[10px] font-bold px-2 py-0.5 rounded-[4px] uppercase tracking-widest ${
              isDark ? 'bg-amber-500/20 text-amber-400' : 'bg-amber-100 text-amber-700'
            }`}>
              Requested
            </span>
          </div>
          <p className={`text-xs ${isDark ? 'text-amber-400/80' : 'text-amber-600'}`}>Pending approval for another member</p>
        </div>
      </div>
    );
  }

  return (
    <button 
      onClick={onClick}
      aria-pressed={selected}
      className={`tactile-card w-full flex items-center p-4 rounded-xl cursor-pointer transition-all duration-fast active:scale-[0.98] border text-left focus:ring-2 focus:ring-accent focus:outline-none ${
        selected 
        ? 'bg-accent/10 border-accent ring-1 ring-accent' 
        : (isDark ? 'glass-card hover:bg-white/5 border-white/25' : 'bg-white hover:bg-black/5 border-black/10 shadow-sm')
      }`}
    >
      <div className={`w-12 h-12 rounded-lg flex-shrink-0 flex items-center justify-center mr-4 overflow-hidden ${selected ? 'bg-accent text-primary' : (isDark ? 'bg-white/5 text-white/70' : 'bg-black/5 text-primary/70')}`}>
        <span className="material-symbols-outlined text-2xl">{resource.icon || 'meeting_room'}</span>
      </div>
      
      <div className="flex-1">
        <div className="flex justify-between items-center mb-0.5">
          <span className={`font-bold text-base ${isDark ? 'text-white' : 'text-primary'}`}>{resource.name}</span>
          {resource.badge && (
            <span className={`w-fit text-[10px] font-bold px-2 py-0.5 rounded-[4px] uppercase tracking-widest ${selected ? 'bg-accent text-primary' : (isDark ? 'bg-white/10 text-white/70' : 'bg-black/10 text-primary/70')}`}>
              {resource.badge}
            </span>
          )}
        </div>
        <p className={`text-xs ${isDark ? 'text-white/80' : 'text-primary/80'}`}>{resource.meta}</p>
      </div>
    </button>
  );
};

export default ResourceCard;

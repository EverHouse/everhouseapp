import React from 'react';
import { useTheme } from '../contexts/ThemeContext';

interface Action {
  icon: string;
  label: string;
  onClick: () => void;
}

interface GlassRowProps {
  title: string;
  subtitle: string;
  icon: string;
  color: string;
  actions?: Action[];
  staggerIndex?: number;
  onClick?: () => void;
  badge?: React.ReactNode;
}

const GlassRow: React.FC<GlassRowProps> = ({ title, subtitle, icon, color, actions, staggerIndex, onClick, badge }) => {
   const { effectiveTheme } = useTheme();
   const isDark = effectiveTheme === 'dark';
   
   return (
     <div 
       onClick={onClick}
       className={`glass-card p-4 flex items-center gap-4 group animate-slide-up-stagger ${onClick ? 'tactile-row cursor-pointer card-pressable glass-interactive transition-transform active:scale-[0.98]' : ''}`} 
       style={staggerIndex !== undefined ? { '--stagger-index': staggerIndex, animationFillMode: 'both' } as React.CSSProperties : { animationFillMode: 'both' }}
     >
        <div className={`w-12 h-12 rounded-[1.5rem] glass-button flex items-center justify-center ${color}`}>
           <span className="material-symbols-outlined text-[24px]">{icon}</span>
        </div>
        <div className="flex-1 min-w-0">
           <div className="flex items-center gap-2">
             <h4 className={`font-bold text-sm truncate ${isDark ? 'text-white' : 'text-primary'}`}>{title}</h4>
             {badge}
           </div>
           <p className={`text-xs truncate ${isDark ? 'text-white/80' : 'text-primary/90'}`}>{subtitle}</p>
        </div>
        {actions && (
            <div className="flex gap-2">
              {actions.map((action, idx) => (
                  <button 
                      key={idx} 
                      onClick={(e) => { e.stopPropagation(); action.onClick(); }} 
                      className={`w-11 h-11 rounded-[1rem] glass-button flex items-center justify-center active:scale-90 ${isDark ? 'text-white/80 hover:text-white' : 'text-primary/80 hover:text-primary'}`}
                      aria-label={action.label}
                  >
                      <span className="material-symbols-outlined text-[18px]">{action.icon}</span>
                  </button>
              ))}
            </div>
        )}
     </div>
   );
};

export default GlassRow;
import React from 'react';

export const Section: React.FC<{title: string; children: React.ReactNode; isDark?: boolean; staggerIndex?: number; id?: string}> = ({ title, children, isDark = true, staggerIndex, id }) => (
  <div id={id} className="animate-slide-up-stagger" style={staggerIndex !== undefined ? { '--stagger-index': staggerIndex } as React.CSSProperties : undefined}>
     <h3 className={`text-2xl leading-tight ml-2 mb-3 ${isDark ? 'text-white' : 'text-primary'}`} style={{ fontFamily: 'var(--font-headline)' }}>{title}</h3>
     <div className={`rounded-xl overflow-hidden glass-card px-0 divide-y ${isDark ? 'divide-white/20 border-white/25' : 'divide-black/5 border-black/10'}`}>
        {children}
     </div>
  </div>
);

export const Row: React.FC<{icon: string; label: string; value?: string; toggle?: boolean; arrow?: boolean; isDark?: boolean; onClick?: () => void}> = ({ icon, label, value, toggle, arrow, isDark = true, onClick }) => (
   <div onClick={onClick} {...(onClick ? { role: 'button', tabIndex: 0, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } } : {})} className={`py-3 px-6 w-full flex items-center justify-between transition-colors cursor-pointer tactile-row ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}>
      <div className="flex items-center gap-4">
         <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>{icon}</span>
         <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>{label}</span>
      </div>
      <div className="flex items-center gap-2">
         {value && <span className={`text-sm ${isDark ? 'opacity-70' : 'text-primary/70'}`}>{value}</span>}
         {toggle && (
            <div className="w-10 h-6 bg-green-500 rounded-full relative">
               <div className="absolute right-1 top-1 w-4 h-4 bg-white rounded-full shadow-sm"></div>
            </div>
         )}
         {arrow && <span className={`material-symbols-outlined text-sm ${isDark ? 'opacity-70' : 'text-primary/70'}`}>arrow_forward_ios</span>}
      </div>
   </div>
);

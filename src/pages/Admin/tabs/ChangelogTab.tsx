import React, { useEffect } from 'react';
import { changelog } from '../../../data/changelog';

const ChangelogTab: React.FC = () => {
    useEffect(() => {
        window.scrollTo(0, 0);
    }, []);

    const formatDate = (dateStr: string) => {
        const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
        const [year, month, day] = datePart.split('-').map(Number);
        const longMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        return `${day} ${longMonths[month - 1]} ${year}`;
    };

    return (
        <div className="space-y-6 animate-pop-in pb-32">
            <div className="text-sm text-primary/80 dark:text-white/80 mb-6">
                A complete history of updates, improvements, and new features added to the Ever House app.
            </div>

            {changelog.map((entry, index) => (
                <div 
                    key={entry.version}
                    className={`relative pl-8 pb-6 ${index !== changelog.length - 1 ? 'border-l-2 border-primary/20 dark:border-white/20' : ''}`}
                >
                    <div className={`absolute left-0 top-0 w-4 h-4 rounded-full -translate-x-[9px] ${
                        entry.isMajor 
                            ? 'bg-primary dark:bg-accent ring-4 ring-primary/20 dark:ring-accent/20' 
                            : 'bg-gray-300 dark:bg-gray-600'
                    }`} />
                    
                    <div className="bg-white/60 dark:bg-white/5 backdrop-blur-sm rounded-2xl p-5 border border-primary/10 dark:border-white/25">
                        <div className="flex items-start justify-between mb-3">
                            <div>
                                <div className="flex items-center gap-2 mb-1">
                                    <span className={`text-lg font-bold ${
                                        entry.isMajor 
                                            ? 'text-primary dark:text-accent' 
                                            : 'text-primary dark:text-white'
                                    }`}>
                                        v{entry.version}
                                    </span>
                                    {entry.isMajor && (
                                        <span className="text-[10px] font-bold uppercase tracking-wider bg-primary/10 dark:bg-accent/20 text-primary dark:text-accent px-2 py-0.5 rounded">
                                            Major Release
                                        </span>
                                    )}
                                </div>
                                <h3 className="text-base font-semibold text-primary dark:text-white">
                                    {entry.title}
                                </h3>
                            </div>
                            <span className="text-xs text-primary/70 dark:text-white/70 whitespace-nowrap">
                                {formatDate(entry.date)}
                            </span>
                        </div>
                        
                        <ul className="space-y-2">
                            {entry.changes.map((change, i) => (
                                <li key={i} className="flex items-start gap-2 text-sm text-primary/80 dark:text-white/80">
                                    <span aria-hidden="true" className="material-symbols-outlined text-sm text-primary/70 dark:text-white/70 mt-0.5">check_circle</span>
                                    {change}
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            ))}
        </div>
    );
};

export default ChangelogTab;

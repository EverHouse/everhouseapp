import React from 'react';
import type { MembershipTier } from './tiersTypes';

interface FeesSubTabProps {
    tiers: MembershipTier[];
    openEdit: (tier: MembershipTier) => void;
}

const FeesSubTab: React.FC<FeesSubTabProps> = ({ tiers, openEdit }) => {
    const oneTimePasses = tiers.filter(t => t.product_type === 'one_time');

    return (
        <div className="space-y-6">
            {oneTimePasses.length > 0 && (
                <div>
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400">
                            Day Passes & Guest Passes
                        </h3>
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                            {oneTimePasses.length} item{oneTimePasses.length !== 1 ? 's' : ''}
                        </span>
                    </div>
                    <div className="space-y-3">
                        {oneTimePasses.map((pass) => (
                            <div 
                                key={pass.id} 
                                role="button"
                                tabIndex={0}
                                onClick={() => openEdit(pass)}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEdit(pass); } }}
                                className="bg-white dark:bg-surface-dark p-4 rounded-xl shadow-sm border border-gray-200 dark:border-white/20 cursor-pointer hover:border-primary/30 transition-all duration-fast"
                            >
                                <div className="flex items-start justify-between">
                                    <div>
                                        <div className="flex items-center gap-2 mb-1">
                                            <h4 className="font-bold text-lg text-primary dark:text-white">{pass.name}</h4>
                                            <span className="text-[10px] font-bold uppercase tracking-wider bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded">
                                                One-time
                                            </span>
                                            {!pass.is_active && (
                                                <span className="text-[10px] font-bold uppercase tracking-wider bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-0.5 rounded">Inactive</span>
                                            )}
                                        </div>
                                        <p className="text-xl font-bold text-primary dark:text-white">{pass.price_string}</p>
                                        {pass.description && (
                                            <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">{pass.description}</p>
                                        )}
                                    </div>
                                    <button aria-label="Edit pass" className="text-gray-600 hover:text-primary dark:hover:text-white transition-colors">
                                        <span aria-hidden="true" className="material-symbols-outlined">edit</span>
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default FeesSubTab;

import React from 'react';
import type { IntegrityMeta } from './dataIntegrityTypes';

interface IntegritySummaryStatsProps {
  meta: IntegrityMeta | null;
  errorCount: number;
  warningCount: number;
  infoCount: number;
}

const IntegritySummaryStats: React.FC<IntegritySummaryStatsProps> = ({
  meta,
  errorCount,
  warningCount,
  infoCount,
}) => {
  if (!meta) return null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
      <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-xl p-4 text-center">
        <p className="text-2xl font-bold text-primary dark:text-white">{meta.totalIssues}</p>
        <p className="text-xs text-primary/60 dark:text-white/60 uppercase tracking-wide">Total Issues</p>
      </div>
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4 text-center">
        <p className="text-2xl font-bold text-red-600 dark:text-red-400">{errorCount}</p>
        <p className="text-xs text-red-600/70 dark:text-red-400/70 uppercase tracking-wide">Errors</p>
      </div>
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4 text-center">
        <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{warningCount}</p>
        <p className="text-xs text-amber-600/70 dark:text-amber-400/70 uppercase tracking-wide">Warnings</p>
      </div>
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4 text-center">
        <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{infoCount}</p>
        <p className="text-xs text-blue-600/70 dark:text-blue-400/70 uppercase tracking-wide">Info</p>
      </div>
    </div>
  );
};

export default IntegritySummaryStats;

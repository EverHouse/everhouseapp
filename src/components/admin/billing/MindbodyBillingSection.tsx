import React from 'react';

interface MindbodyBillingSectionProps {
  mindbodyClientId?: string;
  isDark: boolean;
}

export const MindbodyBillingSection: React.FC<MindbodyBillingSectionProps> = ({
  mindbodyClientId,
  isDark,
}) => {
  return (
    <div className={`p-4 rounded-xl ${isDark ? 'bg-blue-500/10 border border-blue-500/30' : 'bg-blue-50 border border-blue-200'}`}>
      <div className="flex items-start gap-3">
        <span className={`material-symbols-outlined ${isDark ? 'text-blue-400' : 'text-blue-600'} text-xl`}>info</span>
        <div className="flex-1">
          <p className={`text-sm font-medium ${isDark ? 'text-blue-300' : 'text-blue-700'}`}>
            This member is billed through Mindbody
          </p>
          {mindbodyClientId && (
            <p className={`text-xs mt-1 ${isDark ? 'text-blue-400/80' : 'text-blue-600'}`}>
              Mindbody Client ID: {mindbodyClientId}
            </p>
          )}
          <p className={`text-xs mt-2 ${isDark ? 'text-blue-400/80' : 'text-blue-600'}`}>
            To make billing changes, please use the Mindbody system.
          </p>
          <a
            href="https://clients.mindbodyonline.com"
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex items-center gap-1.5 mt-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              isDark ? 'bg-blue-500/20 text-blue-300 hover:bg-blue-500/30' : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
            }`}
          >
            <span className="material-symbols-outlined text-base">open_in_new</span>
            Open Mindbody
          </a>
        </div>
      </div>
    </div>
  );
};

export default MindbodyBillingSection;

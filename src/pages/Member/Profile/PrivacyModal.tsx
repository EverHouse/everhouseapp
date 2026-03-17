import React from 'react';
import Toggle from '../../../components/Toggle';
import ModalShell from '../../../components/ModalShell';

interface PrivacyModalProps {
  isDark: boolean;
  isOpen: boolean;
  onClose: () => void;
  doNotSellMyInfo: boolean;
  handleDoNotSellToggle: (v: boolean) => void;
  updatePreferencesPending: boolean;
  dataExportRequestedAt: string | null;
  handleDataExportRequest: () => void;
  dataExportPending: boolean;
  showDeleteConfirm: boolean;
  setShowDeleteConfirm: (v: boolean) => void;
  deleteAccountPending: boolean;
  onDeleteAccount: () => void;
}

const PrivacyModal: React.FC<PrivacyModalProps> = ({
  isDark,
  isOpen,
  onClose,
  doNotSellMyInfo,
  handleDoNotSellToggle,
  updatePreferencesPending,
  dataExportRequestedAt,
  handleDataExportRequest,
  dataExportPending,
  showDeleteConfirm,
  setShowDeleteConfirm,
  deleteAccountPending,
  onDeleteAccount,
}) => {
  return (
    <ModalShell isOpen={isOpen} onClose={onClose} title="Privacy Settings">
      <div className="space-y-6 p-5">
        <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-black/5'}`}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <span className={`material-symbols-outlined ${isDark ? 'text-white/70' : 'text-primary/70'}`}>security</span>
              <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>Do Not Sell My Information</span>
            </div>
            <Toggle
              checked={doNotSellMyInfo}
              onChange={handleDoNotSellToggle}
              disabled={updatePreferencesPending}
              label="Do Not Sell"
            />
          </div>
          <p className={`text-sm ml-9 ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
            Opt out of having your personal information sold or shared with third parties for targeted advertising.
          </p>
        </div>

        <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-black/5'}`}>
          <div className="flex items-center gap-3 mb-2">
            <span className={`material-symbols-outlined ${isDark ? 'text-white/70' : 'text-primary/70'}`}>download</span>
            <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>Request Data Export</span>
          </div>
          <p className={`text-sm ml-9 mb-3 ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
            Request a copy of all personal data we have stored about you. We will email you within 45 days.
          </p>
          {dataExportRequestedAt ? (
            <p className={`text-sm ml-9 ${isDark ? 'text-accent' : 'text-green-600'}`}>
              ✓ Request submitted on {new Date(dataExportRequestedAt).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })}
            </p>
          ) : (
            <button
              onClick={handleDataExportRequest}
              disabled={dataExportPending}
              className={`ml-9 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                isDark 
                  ? 'bg-white/10 hover:bg-white/20 text-white' 
                  : 'bg-primary/10 hover:bg-primary/20 text-primary'
              } ${dataExportPending ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {dataExportPending ? 'Submitting...' : 'Request Export'}
            </button>
          )}
        </div>

        <div className={`p-4 rounded-xl border ${isDark ? 'border-red-500/30 bg-red-500/10' : 'border-red-200 bg-red-50'}`}>
          <div className="flex items-center gap-3 mb-2">
            <span className={`material-symbols-outlined ${isDark ? 'text-red-400' : 'text-red-600'}`}>delete_forever</span>
            <span className={`font-medium ${isDark ? 'text-red-400' : 'text-red-700'}`}>Delete Account</span>
          </div>
          <p className={`text-sm ml-9 mb-3 ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
            Permanently delete your account and all associated data. This action cannot be undone.
          </p>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="ml-9 px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 text-white transition-colors"
          >
            Delete My Account
          </button>
        </div>

        {showDeleteConfirm && (
          <div className={`p-4 rounded-xl border-2 ${isDark ? 'border-red-500 bg-red-500/20' : 'border-red-300 bg-red-100'}`}>
            <div className="flex items-start gap-3 mb-4">
              <span className={`material-symbols-outlined text-2xl ${isDark ? 'text-red-400' : 'text-red-600'}`}>warning</span>
              <div>
                <h4 className={`font-bold text-lg mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Are you sure?
                </h4>
                <p className={`text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                  This will initiate the termination of your membership and deletion of your data. 
                  This action cannot be undone.
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleteAccountPending}
                className={`flex-1 py-3 font-semibold rounded-xl transition-colors ${
                  isDark 
                    ? 'bg-white/10 hover:bg-white/20 text-white' 
                    : 'bg-gray-200 hover:bg-gray-300 text-gray-800'
                }`}
              >
                Cancel
              </button>
              <button
                onClick={onDeleteAccount}
                disabled={deleteAccountPending}
                className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {deleteAccountPending ? (
                  <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-lg">delete_forever</span>
                    Confirm Delete
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </ModalShell>
  );
};

export default PrivacyModal;

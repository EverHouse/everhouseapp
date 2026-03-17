import React from 'react';
import { Section, Row } from './ProfileShared';

interface StaffSectionProps {
  isDark: boolean;
  user: { role?: string | null };
  staffJobTitle?: string;
  showPasswordSetupBanner: boolean;
  setShowPasswordSetupBanner: (v: boolean) => void;
  showPasswordSection: boolean;
  setShowPasswordSection: (v: boolean) => void;
  hasPassword: boolean;
  currentPassword: string;
  setCurrentPassword: (v: string) => void;
  newPassword: string;
  setNewPassword: (v: string) => void;
  confirmPassword: string;
  setConfirmPassword: (v: string) => void;
  handlePasswordSubmit: () => void;
  setPasswordPending: boolean;
}

const StaffSection: React.FC<StaffSectionProps> = ({
  isDark,
  user,
  staffJobTitle,
  showPasswordSetupBanner,
  setShowPasswordSetupBanner,
  showPasswordSection,
  setShowPasswordSection,
  hasPassword,
  currentPassword,
  setCurrentPassword,
  newPassword,
  setNewPassword,
  confirmPassword,
  setConfirmPassword,
  handlePasswordSubmit,
  setPasswordPending,
}) => {
  return (
    <>
      {showPasswordSetupBanner && (
        <div className={`rounded-xl p-4 mb-4 ${isDark ? 'bg-accent/20 border border-accent/30' : 'bg-amber-50 border border-amber-200'}`}>
          <div className="flex items-start gap-3">
            <span className={`material-symbols-outlined text-xl ${isDark ? 'text-accent' : 'text-amber-600'}`}>key</span>
            <div className="flex-1">
              <p className={`font-semibold text-sm ${isDark ? 'text-accent' : 'text-amber-800'}`}>
                Set Up Password Login (Optional)
              </p>
              <p className={`text-xs mt-1 ${isDark ? 'text-white/80' : 'text-amber-700'}`}>
                For faster access, you can set a password to log in without email codes.
              </p>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => { setShowPasswordSection(true); setShowPasswordSetupBanner(false); }}
                  className={`px-4 py-2 rounded-lg text-xs font-bold ${isDark ? 'bg-accent text-primary' : 'bg-amber-600 text-white'}`}
                >
                  Set Password
                </button>
                <button
                  onClick={() => setShowPasswordSetupBanner(false)}
                  className={`px-4 py-2 rounded-lg text-xs font-medium ${isDark ? 'bg-white/10 text-white/70' : 'bg-amber-100 text-amber-700'}`}
                >
                  Maybe Later
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <Section title="Staff Information" isDark={isDark} staggerIndex={5}>
        <Row icon="shield_person" label="Role" value={user?.role === 'admin' ? 'Administrator' : 'Staff'} isDark={isDark} />
        {staffJobTitle && <Row icon="work" label="Job Title" value={staffJobTitle} isDark={isDark} />}
      </Section>

      <Section title="Security" isDark={isDark} staggerIndex={6}>
        <div 
          className={`py-3 px-6 w-full flex items-center justify-between transition-colors cursor-pointer tactile-row ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowPasswordSection(!showPasswordSection); } }}
          onClick={() => setShowPasswordSection(!showPasswordSection)}
        >
          <div className="flex items-center gap-4">
            <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>key</span>
            <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>
              {hasPassword ? 'Change Password' : 'Set Up Password'}
            </span>
          </div>
          <span className={`material-symbols-outlined text-sm ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
            {showPasswordSection ? 'expand_less' : 'expand_more'}
          </span>
        </div>
        
        {showPasswordSection && (
          <div className="px-4 pb-4 space-y-4">
            {hasPassword && (
              <div>
                <label className={`text-xs font-medium block mb-2 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                  Current Password
                </label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className={`w-full px-4 py-3 rounded-xl text-sm ${
                    isDark 
                      ? 'bg-white/10 text-white placeholder:text-white/40' 
                      : 'bg-black/5 text-primary placeholder:text-primary/40'
                  }`}
                  placeholder="Enter current password"
                />
              </div>
            )}
            
            <div>
              <label className={`text-xs font-medium block mb-2 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                New Password
              </label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={`w-full px-4 py-3 rounded-xl text-sm ${
                  isDark 
                    ? 'bg-white/10 text-white placeholder:text-white/40' 
                    : 'bg-black/5 text-primary placeholder:text-primary/40'
                }`}
                placeholder="At least 8 characters"
              />
            </div>
            
            <div>
              <label className={`text-xs font-medium block mb-2 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                Confirm Password
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={`w-full px-4 py-3 rounded-xl text-sm ${
                  isDark 
                    ? 'bg-white/10 text-white placeholder:text-white/40' 
                    : 'bg-black/5 text-primary placeholder:text-primary/40'
                }`}
                placeholder="Confirm new password"
              />
            </div>
            
            <button
              onClick={handlePasswordSubmit}
              disabled={setPasswordPending || !newPassword || !confirmPassword}
              className={`w-full py-3 rounded-xl font-semibold text-sm transition-colors flex items-center justify-center gap-2 ${
                setPasswordPending || !newPassword || !confirmPassword
                  ? 'opacity-50 cursor-not-allowed bg-primary/50 text-white/70'
                  : 'bg-primary text-white hover:bg-primary/90'
              }`}
            >
              {setPasswordPending ? (
                <>
                  <span className="material-symbols-outlined text-lg animate-spin">progress_activity</span>
                  Saving...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-lg">check</span>
                  {hasPassword ? 'Update Password' : 'Set Password'}
                </>
              )}
            </button>
          </div>
        )}
      </Section>
    </>
  );
};

export default StaffSection;

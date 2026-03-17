import React from 'react';
import Toggle from '../../../components/Toggle';
import { Section, Row } from './ProfileShared';

interface SettingsSectionProps {
  isDark: boolean;
  isStaffOrAdminProfile: boolean;
  pushEnabled: boolean;
  pushSupported: boolean;
  pushLoading: boolean;
  handlePushToggle: (v: boolean) => void;
  showSmsDetails: boolean;
  setShowSmsDetails: (v: boolean) => void;
  emailOptIn: boolean | null;
  smsOptIn: boolean | null;
  smsPromoOptIn: boolean | null | undefined;
  smsTransactionalOptIn: boolean | null | undefined;
  smsRemindersOptIn: boolean | null | undefined;
  handlePreferenceToggle: (type: 'email' | 'sms', newValue: boolean) => void;
  handleSmsPreferenceToggle: (type: 'promo' | 'transactional' | 'reminders', newValue: boolean) => void;
  updatePreferencesPending: boolean;
  updateSmsPreferencesPending: boolean;
  onPrivacyClick: () => void;
}

const SettingsSection: React.FC<SettingsSectionProps> = ({
  isDark,
  isStaffOrAdminProfile,
  pushEnabled,
  pushSupported,
  pushLoading,
  handlePushToggle,
  showSmsDetails,
  setShowSmsDetails,
  emailOptIn,
  smsOptIn,
  smsPromoOptIn,
  smsTransactionalOptIn,
  smsRemindersOptIn,
  handlePreferenceToggle,
  handleSmsPreferenceToggle,
  updatePreferencesPending,
  updateSmsPreferencesPending,
  onPrivacyClick,
}) => {
  return (
    <Section title="Settings" isDark={isDark} staggerIndex={4}>
      <div className={`py-3 px-6 w-full flex items-center justify-between transition-colors ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}>
        <div className="flex items-center gap-4">
          <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>notifications</span>
          <div>
            <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>Push Notifications</span>
            <p className={`text-xs mt-0.5 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
              {isStaffOrAdminProfile 
                ? 'Get notified of new booking requests' 
                : 'Get notified when bookings are approved'}
            </p>
            {!pushSupported && (
              <p className={`text-xs mt-1 ${isDark ? 'text-amber-400/70' : 'text-amber-600'}`}>
                Not supported in this browser
              </p>
            )}
          </div>
        </div>
        <Toggle
          checked={pushEnabled}
          onChange={handlePushToggle}
          disabled={pushLoading || !pushSupported}
          label="Push Notifications"
        />
      </div>
      
      {!isStaffOrAdminProfile && (
        <>
          <div className={`py-3 px-6 w-full flex items-center justify-between transition-colors ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}>
            <div className="flex items-center gap-4">
              <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>mail</span>
              <div>
                <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>Email Updates</span>
                <p className={`text-xs mt-0.5 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                  Receive club news and updates via email
                </p>
              </div>
            </div>
            <Toggle
              checked={emailOptIn ?? false}
              onChange={(val) => handlePreferenceToggle('email', val)}
              disabled={updatePreferencesPending}
              label="Email Updates"
            />
          </div>
          <div className={`py-3 px-6 w-full flex items-center justify-between transition-colors ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}>
            <div className="flex items-center gap-4">
              <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>sms</span>
              <div>
                <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>SMS Updates</span>
                <p className={`text-xs mt-0.5 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                  Receive reminders and alerts via text message
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSmsDetails(!showSmsDetails)}
                className={`p-1 rounded-lg transition-colors ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'}`}
                title="SMS Preferences"
              >
                <span className={`material-symbols-outlined text-lg ${isDark ? 'opacity-60' : 'text-primary/60'}`}>
                  {showSmsDetails ? 'expand_less' : 'tune'}
                </span>
              </button>
              <Toggle
                checked={smsOptIn ?? false}
                onChange={(val) => handlePreferenceToggle('sms', val)}
                disabled={updatePreferencesPending}
                label="SMS Updates"
              />
            </div>
          </div>
          
          {showSmsDetails && (
            <div className={`ml-8 mr-4 mb-4 p-3 rounded-xl space-y-3 ${isDark ? 'bg-white/5' : 'bg-black/5'}`}>
              <p className={`text-xs font-medium mb-2 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                Fine-tune your SMS preferences:
              </p>
              
              <div className="flex items-center justify-between">
                <div>
                  <span className={`text-sm ${isDark ? '' : 'text-primary'}`}>Promotional</span>
                  <p className={`text-xs ${isDark ? 'opacity-60' : 'text-primary/60'}`}>
                    Deals, events, and special offers
                  </p>
                </div>
                <Toggle
                  checked={smsPromoOptIn ?? false}
                  onChange={(val) => handleSmsPreferenceToggle('promo', val)}
                  disabled={updateSmsPreferencesPending}
                  label="Promotional SMS"
                />
              </div>
              
              <div className="flex items-center justify-between">
                <div>
                  <span className={`text-sm ${isDark ? '' : 'text-primary'}`}>Account Updates</span>
                  <p className={`text-xs ${isDark ? 'opacity-60' : 'text-primary/60'}`}>
                    Booking confirmations and billing
                  </p>
                </div>
                <Toggle
                  checked={smsTransactionalOptIn ?? false}
                  onChange={(val) => handleSmsPreferenceToggle('transactional', val)}
                  disabled={updateSmsPreferencesPending}
                  label="Account Updates SMS"
                />
              </div>
              
              <div className="flex items-center justify-between">
                <div>
                  <span className={`text-sm ${isDark ? '' : 'text-primary'}`}>Reminders</span>
                  <p className={`text-xs ${isDark ? 'opacity-60' : 'text-primary/60'}`}>
                    Session and appointment reminders
                  </p>
                </div>
                <Toggle
                  checked={smsRemindersOptIn ?? false}
                  onChange={(val) => handleSmsPreferenceToggle('reminders', val)}
                  disabled={updateSmsPreferencesPending}
                  label="Reminders SMS"
                />
              </div>
            </div>
          )}
        </>
      )}
      
      <Row icon="lock" label="Privacy" arrow isDark={isDark} onClick={onPrivacyClick} />
    </Section>
  );
};

export default SettingsSection;

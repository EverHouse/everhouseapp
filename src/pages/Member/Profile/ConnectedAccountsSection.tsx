import React from 'react';
import GoogleSignInButton from '../../../components/GoogleSignInButton';
import AppleSignInButton from '../../../components/AppleSignInButton';
import { Section } from './ProfileShared';

interface ConnectedAccountsSectionProps {
  isDark: boolean;
  googleStatus: { linked: boolean; googleEmail?: string } | undefined;
  googleLinking: boolean;
  googleUnlinking: boolean;
  handleGoogleLink: (credential: string) => void;
  handleGoogleUnlink: () => void;
  appleStatus: { linked: boolean; appleEmail?: string } | undefined;
  appleLinking: boolean;
  appleUnlinking: boolean;
  handleAppleLink: (data: { identityToken: string; user?: { name?: { firstName?: string; lastName?: string }; email?: string } }) => void;
  handleAppleUnlink: () => void;
  showToast: (msg: string, type: 'success' | 'error' | 'info' | 'warning') => void;
}

const ConnectedAccountsSection: React.FC<ConnectedAccountsSectionProps> = ({
  isDark,
  googleStatus,
  googleLinking,
  googleUnlinking,
  handleGoogleLink,
  handleGoogleUnlink,
  appleStatus,
  appleLinking,
  appleUnlinking,
  handleAppleLink,
  handleAppleUnlink,
  showToast,
}) => {
  return (
    <Section title="Connected Accounts" isDark={isDark} staggerIndex={5}>
      <div className="py-3 px-6 w-full transition-colors">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            <div>
              <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>Google</span>
              {googleStatus?.linked ? (
                <p className={`text-xs mt-0.5 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                  {googleStatus.googleEmail}
                </p>
              ) : (
                <p className={`text-xs mt-0.5 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                  Sign in faster with your Google account
                </p>
              )}
            </div>
          </div>
          <div>
            {googleStatus?.linked ? (
              <button
                onClick={handleGoogleUnlink}
                disabled={googleUnlinking}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-fast ${
                  isDark 
                    ? 'bg-white/10 text-white/70 hover:bg-white/20' 
                    : 'bg-black/5 text-primary/70 hover:bg-black/10'
                } disabled:opacity-50`}
              >
                {googleUnlinking ? 'Unlinking...' : 'Unlink'}
              </button>
            ) : (
              <GoogleSignInButton
                onSuccess={handleGoogleLink}
                onError={(err) => showToast(err, 'error')}
                compact
                label="Link"
                disabled={googleLinking}
              />
            )}
          </div>
        </div>
      </div>

      <div className={`py-3 px-6`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="currentColor" d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
            </svg>
            <div>
              <span className={`font-medium text-sm`}>Apple</span>
              {appleStatus?.linked ? (
                <p className={`text-xs mt-0.5 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                  {appleStatus.appleEmail || 'Connected'}
                </p>
              ) : (
                <p className={`text-xs mt-0.5 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                  Sign in faster with your Apple account
                </p>
              )}
            </div>
          </div>
          <div>
            {appleStatus?.linked ? (
              <button
                onClick={handleAppleUnlink}
                disabled={appleUnlinking}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-fast ${
                  isDark 
                    ? 'bg-white/10 text-white/70 hover:bg-white/20' 
                    : 'bg-black/5 text-primary/70 hover:bg-black/10'
                } disabled:opacity-50`}
              >
                {appleUnlinking ? 'Unlinking...' : 'Unlink'}
              </button>
            ) : (
              <AppleSignInButton
                onSuccess={handleAppleLink}
                onError={(err) => showToast(err, 'error')}
                disabled={appleLinking}
                compact
                label="Link"
              />
            )}
          </div>
        </div>
      </div>
    </Section>
  );
};

export default ConnectedAccountsSection;

import React from 'react';
import { Section } from './ProfileShared';

interface PasskeysSectionProps {
  isDark: boolean;
  passkeyData: { passkeys: Array<{ id: number; credentialId: string; deviceName: string | null; createdAt: string; lastUsedAt: string | null }> } | undefined;
  passkeyRegistering: boolean;
  passkeyRemoving: number | null;
  handlePasskeyRegister: () => void;
  handlePasskeyRemove: (id: number) => void;
}

const PasskeysSection: React.FC<PasskeysSectionProps> = ({
  isDark,
  passkeyData,
  passkeyRegistering,
  passkeyRemoving,
  handlePasskeyRegister,
  handlePasskeyRemove,
}) => {
  return (
    <Section title="Passkeys" isDark={isDark} staggerIndex={6} id="passkeys-section">
      {passkeyData?.passkeys && passkeyData.passkeys.length > 0 ? (
        <>
          {passkeyData.passkeys.map((pk) => (
            <div key={pk.id} className="py-3 px-6 w-full transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>fingerprint</span>
                  <div>
                    <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>
                      {pk.deviceName || 'Passkey'}
                    </span>
                    <p className={`text-xs mt-0.5 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                      Added {new Date(pk.createdAt).toLocaleDateString()}
                      {pk.lastUsedAt && ` · Last used ${new Date(pk.lastUsedAt).toLocaleDateString()}`}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => handlePasskeyRemove(pk.id)}
                  disabled={passkeyRemoving === pk.id}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-fast ${
                    isDark 
                      ? 'bg-white/10 text-white/70 hover:bg-red-500/20 hover:text-red-400' 
                      : 'bg-black/5 text-primary/70 hover:bg-red-50 hover:text-red-600'
                  } disabled:opacity-50`}
                >
                  {passkeyRemoving === pk.id ? 'Removing...' : 'Remove'}
                </button>
              </div>
            </div>
          ))}
          <div className="py-3 px-6">
            <button
              onClick={handlePasskeyRegister}
              disabled={passkeyRegistering}
              className={`flex items-center gap-2 text-sm font-medium transition-all duration-fast ${
                isDark ? 'text-accent hover:text-accent/80' : 'text-primary hover:text-primary/80'
              } disabled:opacity-50`}
            >
              <span className="material-symbols-outlined text-lg">add</span>
              {passkeyRegistering ? 'Registering...' : 'Add another passkey'}
            </button>
          </div>
        </>
      ) : (
        <div className="py-4 px-6">
          <div className="flex items-start gap-4">
            <span className={`material-symbols-outlined text-2xl mt-0.5 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>fingerprint</span>
            <div className="flex-1">
              <p className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>
                Sign in with Face ID / Touch ID
              </p>
              <p className={`text-xs mt-1 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                Skip verification codes — sign in instantly with your device's biometrics.
              </p>
              <button
                onClick={handlePasskeyRegister}
                disabled={passkeyRegistering}
                className={`mt-3 px-4 py-2 rounded-lg text-xs font-bold transition-all duration-fast ${
                  isDark ? 'bg-accent text-primary' : 'bg-primary text-white'
                } disabled:opacity-50`}
              >
                {passkeyRegistering ? 'Setting up...' : 'Set Up Passkey'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
};

export default PasskeysSection;

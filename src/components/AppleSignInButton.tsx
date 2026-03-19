import React, { useCallback, useEffect } from 'react';

interface AppleSignInButtonProps {
  onSuccess: (data: { identityToken: string; user?: { name?: { firstName?: string; lastName?: string }; email?: string } }) => void;
  onError?: (error: string) => void;
  disabled?: boolean;
  compact?: boolean;
  label?: string;
}

declare global {
  interface Window {
    AppleID?: {
      auth: {
        init: (config: Record<string, string | boolean>) => void;
        signIn: () => Promise<{
          authorization: {
            id_token: string;
            code: string;
          };
          user?: {
            name?: { firstName?: string; lastName?: string };
            email?: string;
          };
        }>;
      };
    };
  }
}

const APPLE_CLIENT_ID = import.meta.env.VITE_APPLE_CLIENT_ID;

function ensureAppleSDK(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.AppleID) {
      resolve();
      return;
    }

    const existingScript = document.querySelector('script[src*="appleid.auth.js"]');
    if (existingScript) {
      existingScript.remove();
    }

    const script = document.createElement('script');
    script.src = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Apple Sign-In SDK'));
    document.head.appendChild(script);
  });
}

const AppleSignInButton: React.FC<AppleSignInButtonProps> = ({
  onSuccess,
  onError,
  disabled = false,
  compact = false,
  label,
}) => {
  useEffect(() => {
    if (!APPLE_CLIENT_ID) return;
    ensureAppleSDK().catch(err => console.warn('[AppleSignIn] Failed to preload Apple SDK:', err));
  }, []);

  const handleClick = useCallback(async () => {
    if (disabled || !APPLE_CLIENT_ID) return;

    try {
      if (!window.AppleID) {
        await ensureAppleSDK();
      }

      if (!window.AppleID) {
        onError?.('Apple Sign-In is not available');
        return;
      }

      window.AppleID.auth.init({
        clientId: APPLE_CLIENT_ID,
        scope: 'name email',
        redirectURI: window.location.origin + '/login',
        usePopup: true,
      });

      const response = await window.AppleID.auth.signIn();

      if (response.authorization?.id_token) {
        onSuccess({
          identityToken: response.authorization.id_token,
          user: response.user,
        });
      } else {
        onError?.('Apple sign-in was cancelled');
      }
    } catch (err: unknown) {
      const error = err as { error?: string; message?: string };
      if (error?.error === 'popup_closed_by_user') {
        return;
      }
      const detail = error?.error || error?.message || (typeof err === 'string' ? err : '');
      onError?.(detail ? `Apple sign-in failed: ${detail}` : 'Apple sign-in failed. Please try again.');
    }
  }, [disabled, onSuccess, onError]);

  if (!APPLE_CLIENT_ID) return null;

  const compactLabel = label || 'Sign in';
  const fullLabel = label ? `${label} with Apple` : 'Sign in with Apple';

  if (compact) {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className="flex items-center gap-1.5 rounded-full border border-black/10 dark:border-white/20 bg-black dark:bg-white px-3 py-1.5 text-xs font-medium text-white dark:text-black hover:bg-black/90 dark:hover:bg-white/90 transition-all duration-fast disabled:opacity-50"
        style={{ minHeight: 32 }}
      >
        <svg width="12" height="12" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M13.014 9.504c-.024-2.31 1.884-3.42 1.968-3.474-1.074-1.572-2.742-1.788-3.336-1.812-1.416-.144-2.772.84-3.492.84-.72 0-1.836-.822-3.018-.798-1.548.024-2.982.906-3.78 2.298-1.614 2.808-.414 6.966 1.158 9.246.774 1.116 1.692 2.37 2.898 2.328 1.164-.048 1.602-.75 3.006-.75 1.404 0 1.8.75 3.012.726 1.254-.024 2.04-1.134 2.802-2.256.888-1.29 1.254-2.544 1.272-2.61-.03-.012-2.436-.936-2.49-3.738zM10.698 2.85c.636-.78 1.068-1.854.948-2.934-.918.042-2.04.618-2.7 1.386-.588.684-1.11 1.788-.972 2.838 1.026.078 2.076-.516 2.724-1.29z" fill="currentColor"/>
        </svg>
        {compactLabel}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className="tactile-btn flex w-full items-center justify-center gap-3 rounded-full border border-black/10 dark:border-white/20 bg-white dark:bg-black px-4 py-3 text-sm font-medium text-black dark:text-white hover:bg-gray-50 dark:hover:bg-white/10 transition-all duration-fast active:scale-[0.98] disabled:opacity-50"
      style={{ minHeight: 44 }}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M13.014 9.504c-.024-2.31 1.884-3.42 1.968-3.474-1.074-1.572-2.742-1.788-3.336-1.812-1.416-.144-2.772.84-3.492.84-.72 0-1.836-.822-3.018-.798-1.548.024-2.982.906-3.78 2.298-1.614 2.808-.414 6.966 1.158 9.246.774 1.116 1.692 2.37 2.898 2.328 1.164-.048 1.602-.75 3.006-.75 1.404 0 1.8.75 3.012.726 1.254-.024 2.04-1.134 2.802-2.256.888-1.29 1.254-2.544 1.272-2.61-.03-.012-2.436-.936-2.49-3.738zM10.698 2.85c.636-.78 1.068-1.854.948-2.934-.918.042-2.04.618-2.7 1.386-.588.684-1.11 1.788-.972 2.838 1.026.078 2.076-.516 2.724-1.29z" fill="currentColor"/>
      </svg>
      {fullLabel}
    </button>
  );
};

export default AppleSignInButton;

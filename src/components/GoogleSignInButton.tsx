import React, { useEffect, useRef, useState } from 'react';

type GoogleApi = {
  accounts: {
    id: {
      initialize: (opts: Record<string, unknown>) => void;
      renderButton: (el: HTMLElement | null, opts: Record<string, unknown>) => void;
    };
  };
};

function getGoogleApi(): GoogleApi | undefined {
  return (window as unknown as { google?: GoogleApi }).google;
}

interface GoogleSignInButtonProps {
  onSuccess: (credential: string) => void;
  onError?: (error: string) => void;
  text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
  width?: number;
  disabled?: boolean;
  compact?: boolean;
  label?: string;
}

function ensureGoogleScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (getGoogleApi()?.accounts?.id) {
      resolve();
      return;
    }

    const existingScript = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
    if (existingScript) {
      if (getGoogleApi()?.accounts?.id) {
        resolve();
      } else {
        const onLoad = () => resolve();
        existingScript.addEventListener('load', onLoad);
      }
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Sign-In'));
    document.head.appendChild(script);
  });
}

// NOTE: For Google Sign-In to work in development, the current Replit dev domain
// must be added to the Google Cloud Console authorized JavaScript origins for the
// client ID specified in VITE_GOOGLE_CLIENT_ID. Production domain (everclub.app)
// must also be listed there. Without this, the browser will show:
// "The given origin is not allowed for the given client ID"
const GoogleSignInButton: React.FC<GoogleSignInButtonProps> = ({ 
  onSuccess, 
  onError, 
  text = 'signin_with',
  width,
  disabled = false,
  compact = false,
  label,
}) => {
  const buttonRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

  const onSuccessRef = useRef(onSuccess);
  const onErrorRef = useRef(onError);
  useEffect(() => { onSuccessRef.current = onSuccess; }, [onSuccess]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    if (!clientId) return;
    ensureGoogleScript()
      .then(() => setLoaded(true))
      .catch(() => onErrorRef.current?.('Failed to load Google Sign-In'));
  }, [clientId]);

  useEffect(() => {
    if (!loaded || !clientId) return;

    const google = getGoogleApi();
    if (!google?.accounts?.id) return;

    google.accounts.id.initialize({
      client_id: clientId,
      ux_mode: 'popup',
      callback: (response: { credential: string }) => {
        if (response.credential) {
          onSuccessRef.current(response.credential);
        } else {
          onErrorRef.current?.('Google sign-in was cancelled');
        }
      },
    });

    if (buttonRef.current) {
      google.accounts.id.renderButton(buttonRef.current, {
        type: 'standard',
        theme: 'outline',
        size: compact ? 'medium' : 'large',
        text: compact ? 'signin' : text,
        shape: 'pill',
        width: compact ? 80 : (width || buttonRef.current.offsetWidth),
        logo_alignment: 'left',
      });
    }
  }, [loaded, clientId, text, width, compact]);

  if (!clientId) return null;

  if (compact) {
    const compactLabel = label || 'Sign in';
    return (
      <div className="relative" style={{ minHeight: 32 }}>
        <div className="flex items-center gap-1.5 rounded-full border border-black/10 dark:border-white/20 bg-white dark:bg-black px-3 py-1.5 text-xs font-medium text-black dark:text-white pointer-events-none"
          style={{ minHeight: 32 }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          {compactLabel}
        </div>
        <div
          ref={buttonRef}
          className={`absolute inset-0 overflow-hidden opacity-[0.01] ${disabled ? 'pointer-events-none' : ''}`}
          style={{ minHeight: 32 }}
        />
      </div>
    );
  }

  return (
    <div 
      ref={buttonRef} 
      className={`w-full flex justify-center ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
      style={{ minHeight: 44 }}
    />
  );
};

export default GoogleSignInButton;

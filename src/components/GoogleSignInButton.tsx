import React, { useEffect, useRef, useState } from 'react';

interface GoogleSignInButtonProps {
  onSuccess: (credential: string) => void;
  onError?: (error: string) => void;
  text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
  width?: number;
  disabled?: boolean;
}

const GoogleSignInButton: React.FC<GoogleSignInButtonProps> = ({ 
  onSuccess, 
  onError, 
  text = 'signin_with',
  width,
  disabled = false
}) => {
  const buttonRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

  useEffect(() => {
    if (!clientId) return;
    
    const existingScript = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
    if (existingScript) {
      if ((window as unknown as { google?: { accounts?: { id?: { initialize: (opts: unknown) => void; renderButton: (el: HTMLElement, opts: unknown) => void } } } }).google?.accounts?.id) {
        setLoaded(true);
      } else {
        existingScript.addEventListener('load', () => setLoaded(true));
      }
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => setLoaded(true);
    script.onerror = () => onError?.('Failed to load Google Sign-In');
    document.head.appendChild(script);
  }, [clientId]);

  useEffect(() => {
    if (!loaded || !clientId || !buttonRef.current) return;

    const google = (window as unknown as { google?: { accounts?: { id?: { initialize: (opts: { client_id: string; callback: (response: { credential: string }) => void }) => void; renderButton: (el: HTMLElement | null, opts: Record<string, unknown>) => void } } } }).google;
    if (!google?.accounts?.id) return;

    const loginUri = `${window.location.origin}/api/auth/google/callback`;

    google.accounts.id.initialize({
      client_id: clientId,
      ux_mode: 'popup',
      login_uri: loginUri,
      callback: (response: { credential: string }) => {
        if (response.credential) {
          onSuccess(response.credential);
        } else {
          onError?.('Google sign-in was cancelled');
        }
      },
    });

    google.accounts.id.renderButton(buttonRef.current, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      text,
      shape: 'pill',
      width: width || buttonRef.current.offsetWidth,
      logo_alignment: 'left',
    });
  }, [loaded, clientId, text, width]);

  if (!clientId) return null;

  return (
    <div 
      ref={buttonRef} 
      className={`w-full flex justify-center ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
      style={{ minHeight: 44 }}
    />
  );
};

export default GoogleSignInButton;

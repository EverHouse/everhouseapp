import { useState, useCallback } from 'react';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/types';
import { useQuery } from '@tanstack/react-query';
import { useToast } from '../../../components/Toast';
import { fetchWithCredentials, postWithCredentials, deleteWithCredentials } from '../../../hooks/queries/useFetch';

export function useProfileAuth(userExists: boolean) {
  const { showToast } = useToast();

  const [googleLinking, setGoogleLinking] = useState(false);
  const [googleUnlinking, setGoogleUnlinking] = useState(false);
  const [appleLinking, setAppleLinking] = useState(false);
  const [appleUnlinking, setAppleUnlinking] = useState(false);
  const [passkeyRegistering, setPasskeyRegistering] = useState(false);
  const [passkeyRemoving, setPasskeyRemoving] = useState<number | null>(null);

  const { data: googleStatus, refetch: refetchGoogleStatus } = useQuery({
    queryKey: ['google-status'],
    queryFn: () => fetchWithCredentials<{ linked: boolean; googleEmail?: string }>('/api/auth/google/status'),
    enabled: userExists,
  });

  const { data: appleStatus, refetch: refetchAppleStatus } = useQuery({
    queryKey: ['apple-status'],
    queryFn: () => fetchWithCredentials<{ linked: boolean; appleEmail?: string }>('/api/auth/apple/status'),
    enabled: userExists,
  });

  const { data: passkeyData, refetch: refetchPasskeys } = useQuery({
    queryKey: ['passkeys'],
    queryFn: () => fetchWithCredentials<{ passkeys: Array<{ id: number; credentialId: string; deviceName: string | null; createdAt: string; lastUsedAt: string | null }> }>('/api/auth/passkey/list'),
    enabled: userExists,
  });

  const passkeySupported = typeof window !== 'undefined' && !!window.PublicKeyCredential;

  const handleGoogleLink = useCallback(async (credential: string) => {
    setGoogleLinking(true);
    try {
      const res = await postWithCredentials<{ error?: string }>('/api/auth/google/link', { credential });
      if (res.error) throw new Error(res.error);
      await refetchGoogleStatus();
      showToast('Google account linked successfully', 'success');
    } catch (err: unknown) {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to link Google account', 'error');
    } finally {
      setGoogleLinking(false);
    }
  }, [showToast, refetchGoogleStatus]);

  const handleGoogleUnlink = useCallback(async () => {
    setGoogleUnlinking(true);
    try {
      const res = await postWithCredentials<{ error?: string }>('/api/auth/google/unlink', {});
      if (res.error) throw new Error(res.error);
      await refetchGoogleStatus();
      showToast('Google account unlinked', 'success');
    } catch (err: unknown) {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to unlink Google account', 'error');
    } finally {
      setGoogleUnlinking(false);
    }
  }, [showToast, refetchGoogleStatus]);

  const handleAppleLink = useCallback(async (data: { identityToken: string; user?: { name?: { firstName?: string; lastName?: string }; email?: string } }) => {
    setAppleLinking(true);
    try {
      const res = await postWithCredentials<{ error?: string }>('/api/auth/apple/link', {
        identityToken: data.identityToken,
        user: data.user,
      });
      if (res.error) throw new Error(res.error);
      await refetchAppleStatus();
      showToast('Apple account linked successfully', 'success');
    } catch (err: unknown) {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to link Apple account', 'error');
    } finally {
      setAppleLinking(false);
    }
  }, [showToast, refetchAppleStatus]);

  const handleAppleUnlink = useCallback(async () => {
    setAppleUnlinking(true);
    try {
      const res = await postWithCredentials<{ error?: string }>('/api/auth/apple/unlink', {});
      if (res.error) throw new Error(res.error);
      await refetchAppleStatus();
      showToast('Apple account unlinked', 'success');
    } catch (err: unknown) {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to unlink Apple account', 'error');
    } finally {
      setAppleUnlinking(false);
    }
  }, [showToast, refetchAppleStatus]);

  const handlePasskeyRegister = useCallback(async () => {
    setPasskeyRegistering(true);
    try {
      const { startRegistration } = await import('@simplewebauthn/browser');

      const options = await postWithCredentials<PublicKeyCredentialCreationOptionsJSON>('/api/auth/passkey/register/options', {});
      const regResponse = await startRegistration({ optionsJSON: options });

      await postWithCredentials('/api/auth/passkey/register/verify', regResponse);

      await refetchPasskeys();
      showToast('Passkey registered! You can now sign in with Face ID / Touch ID.', 'success');
    } catch (err: unknown) {
      const error = err as { name?: string; message?: string };
      if (error?.name === 'NotAllowedError') {
        return;
      }
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to register passkey', 'error');
    } finally {
      setPasskeyRegistering(false);
    }
  }, [showToast, refetchPasskeys]);

  const handlePasskeyRemove = useCallback(async (passkeyId: number) => {
    setPasskeyRemoving(passkeyId);
    try {
      await deleteWithCredentials(`/api/auth/passkey/${passkeyId}`);

      await refetchPasskeys();
      showToast('Passkey removed', 'success');
    } catch (err: unknown) {
      showToast((err instanceof Error ? err.message : String(err)) || 'Failed to remove passkey', 'error');
    } finally {
      setPasskeyRemoving(null);
    }
  }, [showToast, refetchPasskeys]);

  return {
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
    passkeySupported,
    passkeyData,
    passkeyRegistering,
    passkeyRemoving,
    handlePasskeyRegister,
    handlePasskeyRemove,
  };
}

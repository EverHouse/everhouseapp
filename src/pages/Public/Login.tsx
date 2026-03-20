import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import { useAuthData } from '../../contexts/DataContext';
import { usePageReady } from '../../stores/pageReadyStore';
import { useNavigationLoading } from '../../stores/navigationLoadingStore';
import WalkingGolferSpinner from '../../components/WalkingGolferSpinner';
import GoogleSignInButton from '../../components/GoogleSignInButton';
import AppleSignInButton from '../../components/AppleSignInButton';
import { startAuthentication, WebAuthnAbortService } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/types';
import { fetchWithCredentials, postWithCredentials, isAbortError } from '../../hooks/queries/useFetch';
import type { MemberProfile } from '../../types/data';
import Icon from '../../components/icons/Icon';

const Spinner = () => (
  <WalkingGolferSpinner size="sm" variant="light" />
);

const GOOGLE_REDIRECT_ERRORS: Record<string, string> = {
  missing_credential: 'Google sign-in failed. Please try again.',
  no_membership: 'No membership found for this email. Please sign up or use the email associated with your membership.',
  inactive_membership: 'Your membership is not active. Please contact us for assistance.',
  session_failed: 'Failed to create session. Please try again.',
  google_failed: 'Google sign-in failed. Please try again.',
};

const Login: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { startNavigation } = useNavigationLoading();
  const { loginWithMember, user, actualUser, isViewingAs, sessionChecked } = useAuthData();
  const { setPageReady } = usePageReady();
  const [email, setEmail] = useState('');
  
  useEffect(() => {
    if (!sessionChecked) return;
    if (user) {
      const staffOrAdmin = actualUser?.role === 'admin' || actualUser?.role === 'staff';
      navigate((staffOrAdmin && !isViewingAs) ? '/admin' : '/dashboard', { replace: true });
      return;
    }
    setPageReady(true);
  }, [sessionChecked, user, actualUser, isViewingAs, navigate, setPageReady]);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [devLoading, setDevLoading] = useState(false);
  const [devMemberLoading, setDevMemberLoading] = useState(false);
  const redirectError = searchParams.get('error');
  const [error, setError] = useState(redirectError ? (GOOGLE_REDIRECT_ERRORS[redirectError] || 'Sign-in failed. Please try again.') : '');

  useEffect(() => {
    if (redirectError) {
      setSearchParams({}, { replace: true });
    }
  }, [redirectError, setSearchParams]);
  const [isStaffOrAdmin, setIsStaffOrAdmin] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [showPasswordField, setShowPasswordField] = useState(false);
  const [checkingEmail, setCheckingEmail] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [otpInputs, setOtpInputs] = useState(['', '', '', '', '', '']);
  const otpRefs = useRef<(HTMLInputElement | null)[]>([]);
  
  const [googleLoading, setGoogleLoading] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  
  const isDev = import.meta.env.DEV;
  
  const _isPWA = typeof window !== 'undefined' && (
    (window.navigator as unknown as { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );

  const conditionalActiveRef = useRef(false);
  const manualPasskeyInFlightRef = useRef(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.PublicKeyCredential) {
      setPasskeyAvailable(true);

      const tryConditionalUI = async () => {
        try {
          const available = typeof PublicKeyCredential.isConditionalMediationAvailable === 'function'
            && await PublicKeyCredential.isConditionalMediationAvailable();
          if (!available) return;

          const options = await postWithCredentials<PublicKeyCredentialRequestOptionsJSON>('/api/auth/passkey/authenticate/options', {});
          conditionalActiveRef.current = true;

          const authResponse = await startAuthentication({
            optionsJSON: options,
            useBrowserAutofill: true,
          });

          conditionalActiveRef.current = false;
          setPasskeyLoading(true);
          const data = await postWithCredentials<{ member: MemberProfile }>('/api/auth/passkey/authenticate/verify', authResponse);

          loginWithMember(data.member);
          const isStaff = data.member.role === 'admin' || data.member.role === 'staff';
          startNavigation();
          navigate(isStaff ? '/admin' : '/dashboard');
        } catch (err: unknown) {
          conditionalActiveRef.current = false;
          const e = err as { name?: string };
          if (e?.name === 'AbortError' || e?.name === 'NotAllowedError') return;
        } finally {
          if (!manualPasskeyInFlightRef.current) {
            setPasskeyLoading(false);
          }
        }
      };
      tryConditionalUI();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePasskeyLogin = useCallback(async () => {
    if (conditionalActiveRef.current) {
      WebAuthnAbortService.cancelCeremony();
      conditionalActiveRef.current = false;
    }
    manualPasskeyInFlightRef.current = true;
    setPasskeyLoading(true);
    setError('');

    try {
      const options = await postWithCredentials<PublicKeyCredentialRequestOptionsJSON>('/api/auth/passkey/authenticate/options', {});
      const authResponse = await startAuthentication({ optionsJSON: options });

      const data = await postWithCredentials<{ member: MemberProfile }>('/api/auth/passkey/authenticate/verify', authResponse);

      loginWithMember(data.member);
      const isStaff = data.member.role === 'admin' || data.member.role === 'staff';
      startNavigation();
      navigate(isStaff ? '/admin' : '/dashboard');
    } catch (err: unknown) {
      const error = err as { name?: string; message?: string };
      if (error?.name === 'NotAllowedError') {
        return;
      }
      setError((err instanceof Error ? err.message : String(err)) || 'Passkey authentication failed');
    } finally {
      manualPasskeyInFlightRef.current = false;
      setPasskeyLoading(false);
    }
  }, [loginWithMember, startNavigation, navigate]);

  const handleGoogleLogin = useCallback(async (credential: string) => {
    setGoogleLoading(true);
    setError('');
    
    try {
      const data = await postWithCredentials<{ member: MemberProfile }>('/api/auth/google/verify', { credential });
      
      loginWithMember(data.member);
      
      const isStaff = data.member.role === 'admin' || data.member.role === 'staff';
      startNavigation();
      navigate(isStaff ? '/admin' : '/dashboard');
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : String(err)) || 'Google sign-in failed');
    } finally {
      setGoogleLoading(false);
    }
  }, [loginWithMember, startNavigation, navigate]);

  const handleAppleLogin = useCallback(async (data: { identityToken: string; user?: { name?: { firstName?: string; lastName?: string }; email?: string } }) => {
    setAppleLoading(true);
    setError('');
    
    try {
      const responseData = await postWithCredentials<{ member: MemberProfile }>('/api/auth/apple/verify', { identityToken: data.identityToken, user: data.user });
      
      loginWithMember(responseData.member);
      
      const isStaff = responseData.member.role === 'admin' || responseData.member.role === 'staff';
      startNavigation();
      navigate(isStaff ? '/admin' : '/dashboard');
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : String(err)) || 'Apple sign-in failed');
    } finally {
      setAppleLoading(false);
    }
  }, [loginWithMember, startNavigation, navigate]);

  const checkStaffAdmin = useCallback(async (emailToCheck: string, signal?: AbortSignal) => {
    if (!emailToCheck || !emailToCheck.includes('@')) return;
    
    setCheckingEmail(true);
    try {
      const data = await fetchWithCredentials<{ isStaffOrAdmin: boolean; hasPassword: boolean }>(
        `/api/auth/check-staff-admin?email=${encodeURIComponent(emailToCheck)}`,
        { signal }
      );
      setIsStaffOrAdmin(data.isStaffOrAdmin);
      setHasPassword(data.hasPassword);
      if (data.isStaffOrAdmin && data.hasPassword) {
        setShowPasswordField(true);
      }
    } catch (err: unknown) {
      if (isAbortError(err)) return;
      console.error('Failed to check staff/admin status');
    } finally {
      setCheckingEmail(false);
    }
  }, []);

  useEffect(() => {
    const abortController = new AbortController();
    const debounceTimer = setTimeout(() => {
      if (email.includes('@')) {
        checkStaffAdmin(email, abortController.signal);
      } else {
        setIsStaffOrAdmin(false);
        setHasPassword(false);
        setShowPasswordField(false);
      }
    }, 500);
    
    return () => {
      clearTimeout(debounceTimer);
      abortController.abort();
    };
  }, [email, checkStaffAdmin]);

  const handleDevLogin = async (email?: string) => {
    const isStaffLogin = !email;
    if (isStaffLogin) {
      setDevLoading(true);
    } else {
      setDevMemberLoading(true);
    }
    setError('');
    
    try {
      const { member } = await postWithCredentials<{ member: MemberProfile }>('/api/auth/dev-login', email ? { email } : {});
      loginWithMember(member);
      startNavigation();
      navigate(member.role === 'admin' || member.role === 'staff' ? '/admin' : '/dashboard');
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : String(err)) || 'Dev login failed');
    } finally {
      setDevLoading(false);
      setDevMemberLoading(false);
    }
  };

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    
    try {
      const data = await postWithCredentials<{ member: MemberProfile }>('/api/auth/password-login', { email, password });
      
      loginWithMember(data.member);
      startNavigation();
      navigate(data.member.role === 'admin' || data.member.role === 'staff' ? '/admin' : '/dashboard');
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : String(err)) || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleRequestOTP = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setLoading(true);
    setError('');
    
    try {
      await postWithCredentials('/api/auth/request-otp', { email });
      
      setOtpSent(true);
      setOtpInputs(['', '', '', '', '', '']);
      setTimeout(() => {
        otpRefs.current[0]?.focus();
      }, 100);
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : String(err)) || 'Failed to send login code');
    } finally {
      setLoading(false);
    }
  };

  const handleOtpChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return;
    
    const digits = value.replace(/\D/g, '');
    
    if (digits.length >= 6) {
      const codeDigits = digits.slice(0, 6).split('');
      setOtpInputs(codeDigits);
      handleVerifyOTP(codeDigits.join(''));
      return;
    }
    
    const newInputs = [...otpInputs];
    newInputs[index] = digits.slice(-1);
    setOtpInputs(newInputs);
    
    if (digits && index < 5) {
      otpRefs.current[index + 1]?.focus();
    }
    
    const fullCode = newInputs.join('');
    if (fullCode.length === 6) {
      handleVerifyOTP(fullCode);
    }
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !otpInputs[index] && index > 0) {
      otpRefs.current[index - 1]?.focus();
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent, startIndex: number) => {
    e.preventDefault();
    const pastedText = e.clipboardData.getData('text');
    const digits = pastedText.replace(/\D/g, '').split('');
    
    if (digits.length === 0) return;
    
    const newInputs = [...otpInputs];
    let digitIdx = 0;
    for (let i = startIndex; i < 6 && digitIdx < digits.length; i++) {
      newInputs[i] = digits[digitIdx];
      digitIdx++;
    }
    setOtpInputs(newInputs);
    
    const lastFilledIndex = Math.min(startIndex + digits.length - 1, 5);
    const nextIndex = lastFilledIndex < 5 ? lastFilledIndex + 1 : 5;
    otpRefs.current[nextIndex]?.focus();
    
    if (newInputs.every((digit) => digit.length === 1)) {
      handleVerifyOTP(newInputs.join(''));
    }
  };

  const handleVerifyOTP = async (code: string) => {
    setLoading(true);
    setError('');
    
    try {
      const data = await postWithCredentials<{ member: MemberProfile; shouldSetupPassword?: boolean }>('/api/auth/verify-otp', { email, code });
      
      loginWithMember(data.member);
      
      const isStaff = data.member.role === 'admin' || data.member.role === 'staff';
      const destination = isStaff ? '/admin' : '/dashboard';
      
      const shouldNudgePasskey = passkeyAvailable && !isStaff && !localStorage.getItem('eh_passkey_nudge_dismissed');

      startNavigation();
      if (data.shouldSetupPassword && isStaff) {
        navigate(destination, { state: { showPasswordSetup: true } });
      } else if (shouldNudgePasskey) {
        navigate(destination, { state: { suggestPasskey: true } });
      } else {
        navigate(destination);
      }
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : String(err)) || 'Failed to verify code');
      setOtpInputs(['', '', '', '', '', '']);
      otpRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  if (sessionChecked && user) {
    return (
      <div className="flex flex-col min-h-screen bg-bone dark:bg-[#141414] items-center justify-center">
        <WalkingGolferSpinner size="md" variant="auto" />
      </div>
    );
  }

  if (otpSent) {
    return (
      <div className="flex flex-col min-h-screen bg-bone dark:bg-[#141414] overflow-x-hidden animate-page-enter">
        <div className="flex-1 flex flex-col justify-center px-6 py-12">
          <div className="w-full max-w-sm mx-auto space-y-8">
            <div className="text-center">
              <div className="w-16 h-16 bg-primary text-bone dark:text-[#141414] rounded-full flex items-center justify-center mx-auto text-2xl mb-6 shadow-xl dark:shadow-black/20">
                <Icon name="dialpad" className="text-3xl" />
              </div>
              <h2 className="text-2xl text-primary dark:text-white leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>
                Enter Your Code
              </h2>
              <p className="mt-4 text-base text-primary/60 dark:text-white/60 font-medium leading-relaxed">
                We sent a 6-digit code to<br />
                <span className="font-bold text-primary dark:text-white">{email}</span>
              </p>
            </div>

            {error && (
              <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-700 dark:text-red-400 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
                <Icon name="error" className="text-lg" />
                {error}
              </div>
            )}

            <div className="bg-white dark:bg-[#1a1d15] py-8 px-6 shadow-sm dark:shadow-black/20 rounded-xl border border-black/5 dark:border-white/10 space-y-6">
              <div className="flex justify-center gap-2">
                {otpInputs.map((digit, idx) => (
                  <input
                    key={idx}
                    ref={(el) => { otpRefs.current[idx] = el; }}
                    type="text"
                    inputMode="numeric"
                    autoComplete={idx === 0 ? 'one-time-code' : 'off'}
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handleOtpChange(idx, e.target.value)}
                    onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                    onPaste={(e) => handleOtpPaste(e, idx)}
                    className="w-12 h-14 text-center text-2xl font-bold rounded-xl border border-black/10 dark:border-white/10 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all duration-fast text-primary dark:text-white dark:bg-white/5"
                    disabled={loading}
                  />
                ))}
              </div>
              
              {loading && (
                <div className="text-center text-sm text-primary/60 dark:text-white/60">
                  Verifying...
                </div>
              )}
              
              <div className="flex items-center gap-2 text-center justify-center text-sm text-primary/60 dark:text-white/60">
                <Icon name="schedule" className="text-sm" />
                Code expires in 15 minutes
              </div>
              
              <hr className="border-black/5 dark:border-white/10" />
              
              <div className="space-y-2">
                <button
                  onClick={() => handleRequestOTP()}
                  disabled={loading}
                  className="tactile-btn w-full text-center text-sm text-primary dark:text-white font-medium hover:underline transition-colors disabled:opacity-50"
                >
                  Resend code
                </button>
                <button
                  onClick={() => {
                    setOtpSent(false);
                    setOtpInputs(['', '', '', '', '', '']);
                    setError('');
                  }}
                  className="tactile-btn w-full text-center text-sm text-primary/60 dark:text-white/60 hover:text-primary dark:hover:text-white transition-colors"
                >
                  Use a different email
                </button>
              </div>
            </div>
          </div>
        </div>
        <Footer />
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-bone dark:bg-[#141414] overflow-x-hidden animate-page-enter">
      <div className="flex-1 flex flex-col justify-center px-6 py-12">
        <div className="w-full max-w-sm mx-auto space-y-8">
            
            <div className="text-center">
                <img src="/assets/logos/EH-guy-icon.webp" alt="Ever Club" className="w-16 h-16 mx-auto mb-6 rounded-xl" />
                <h2 className="text-2xl text-primary dark:text-white leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>
                    Member's Portal
                </h2>
                <p className="mt-2 text-base text-primary/60 dark:text-white/60 font-medium">
                    {isStaffOrAdmin && hasPassword ? 'Sign in with your password or verification code.' : 'Enter your email to receive a verification code.'}
                </p>
            </div>

            {error && (
              <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-700 dark:text-red-400 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
                <Icon name="error" className="text-lg" />
                {error}
              </div>
            )}

            <div className="bg-white dark:bg-[#1a1d15] py-8 px-6 shadow-sm dark:shadow-black/20 rounded-xl border border-black/5 dark:border-white/10 space-y-4">
                <form onSubmit={showPasswordField && hasPassword ? handlePasswordLogin : handleRequestOTP} className="space-y-4">
                  <div>
                    <label htmlFor="login-email" className="sr-only">Membership Email</label>
                    <input
                      id="login-email"
                      type="email"
                      autoComplete="username webauthn"
                      placeholder="Membership Email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full px-4 py-3 rounded-xl border border-black/10 dark:border-white/10 focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-all duration-fast text-primary dark:text-white placeholder:text-primary/40 dark:placeholder-white/40 dark:bg-white/5"
                      required
                      autoFocus
                    />
                    {checkingEmail && (
                      <p className="text-xs text-primary/40 dark:text-white/40 mt-1 pl-1">Checking...</p>
                    )}
                  </div>
                  
                  {showPasswordField && hasPassword && (
                    <div className="animate-pop-in">
                      <label htmlFor="login-password" className="sr-only">Password</label>
                      <input
                        id="login-password"
                        type="password"
                        placeholder="Password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full px-4 py-3 rounded-xl border border-black/10 dark:border-white/10 focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-all duration-fast text-primary dark:text-white placeholder:text-primary/40 dark:placeholder-white/40 dark:bg-white/5"
                        required
                      />
                    </div>
                  )}
                  
                  {showPasswordField && hasPassword ? (
                    <button
                      type="submit"
                      disabled={loading || !password}
                      className="tactile-btn flex w-full justify-center items-center gap-3 rounded-[4px] bg-primary px-3 py-4 text-sm font-bold leading-6 text-white shadow-lg dark:shadow-black/20 hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary transition-all duration-fast active:scale-[0.98] disabled:opacity-50"
                    >
                      {loading ? <Spinner /> : <Icon name="login" />}
                      {loading ? 'Signing in...' : 'Sign In'}
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={loading || !email.includes('@')}
                      className="tactile-btn flex w-full justify-center items-center gap-3 rounded-[4px] bg-primary px-3 py-4 text-sm font-bold leading-6 text-white shadow-lg dark:shadow-black/20 hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary transition-all duration-fast active:scale-[0.98] disabled:opacity-50"
                    >
                      {loading ? <Spinner /> : <Icon name="dialpad" />}
                      {loading ? 'Sending...' : 'Send Verification Code'}
                    </button>
                  )}
                </form>

                <div className="relative my-2">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-black/10 dark:border-white/10"></div>
                  </div>
                  <div className="relative flex justify-center text-xs">
                    <span className="bg-white dark:bg-[#1a1d15] px-3 text-primary/40 dark:text-white/40 font-medium">or</span>
                  </div>
                </div>

                <GoogleSignInButton
                  onSuccess={handleGoogleLogin}
                  onError={(err) => setError(err)}
                  disabled={loading || googleLoading || appleLoading}
                />
                {googleLoading && (
                  <div className="text-center text-sm text-primary/60 dark:text-white/60">
                    Signing in with Google...
                  </div>
                )}

                <AppleSignInButton
                  onSuccess={handleAppleLogin}
                  onError={(err) => setError(err)}
                  disabled={loading || googleLoading || appleLoading}
                />
                {appleLoading && (
                  <div className="text-center text-sm text-primary/60 dark:text-white/60">
                    Signing in with Apple...
                  </div>
                )}

                {passkeyAvailable && (
                  <button
                    type="button"
                    onClick={handlePasskeyLogin}
                    disabled={loading || googleLoading || appleLoading || passkeyLoading}
                    className="tactile-btn flex w-full items-center justify-center gap-3 rounded-full border border-black/10 dark:border-white/20 bg-white dark:bg-black px-4 py-3 text-sm font-medium text-black dark:text-white hover:bg-gray-50 dark:hover:bg-white/10 transition-all duration-fast active:scale-[0.98] disabled:opacity-50"
                    style={{ minHeight: 44 }}
                  >
                    <Icon name="fingerprint" className="text-lg" />
                    {passkeyLoading ? 'Authenticating...' : 'Sign in with Face ID / Touch ID'}
                  </button>
                )}

                {showPasswordField && hasPassword && (
                  <div className="animate-pop-in">
                    <hr className="border-black/10 dark:border-white/10" />
                    <button
                      type="button"
                      onClick={handleRequestOTP}
                      disabled={loading}
                      className="tactile-btn flex w-full justify-center items-center gap-2 rounded-[4px] bg-gray-100 dark:bg-white/5 px-3 py-3 text-sm font-bold leading-6 text-primary dark:text-white hover:bg-gray-200 dark:hover:bg-white/10 transition-all duration-fast active:scale-[0.98] disabled:opacity-50 mt-4"
                    >
                      <Icon name="dialpad" className="text-lg" />
                      Use Verification Code Instead
                    </button>
                  </div>
                )}
                
                {isDev && (
                  <>
                    <hr className="border-black/10 dark:border-white/10" />
                    <button
                      type="button"
                      onClick={() => handleDevLogin()}
                      disabled={devLoading || devMemberLoading}
                      className="tactile-btn flex w-full justify-center items-center gap-2 rounded-[4px] bg-amber-500 px-3 py-3 text-sm font-bold leading-6 text-white hover:bg-amber-600 transition-all duration-fast active:scale-[0.98] disabled:opacity-50"
                    >
                      <Icon name="developer_mode" className="text-lg" />
                      {devLoading ? 'Logging in...' : 'Dev Login (Admin)'}
                    </button>
                    <p className="text-center text-xs text-amber-600 dark:text-amber-400">
                      Development only - logs in as nick@everclub.co
                    </p>
                    <button
                      type="button"
                      onClick={() => handleDevLogin('nicholasallanluu@gmail.com')}
                      disabled={devLoading || devMemberLoading}
                      className="tactile-btn flex w-full justify-center items-center gap-2 rounded-[4px] bg-purple-500 px-3 py-3 text-sm font-bold leading-6 text-white hover:bg-purple-600 transition-all duration-fast active:scale-[0.98] disabled:opacity-50"
                    >
                      <Icon name="person" className="text-lg" />
                      {devMemberLoading ? 'Logging in...' : 'Dev Login (Member)'}
                    </button>
                    <p className="text-center text-xs text-purple-600 dark:text-purple-400">
                      Development only - logs in as nicholasallanluu@gmail.com
                    </p>
                  </>
                )}
            </div>

            <p className="text-center text-sm text-primary/60 dark:text-white/60 font-medium">
                Not a member?{' '}
                <button onClick={() => { startNavigation(); navigate('/membership'); }} className="font-bold text-primary dark:text-white hover:underline">
                    Apply today
                </button>
            </p>
        </div>
      </div>
      <Footer />
    </div>
  );
};

export default Login;

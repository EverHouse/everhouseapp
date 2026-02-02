import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import { useData } from '../../contexts/DataContext';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useNavigationLoading } from '../../contexts/NavigationLoadingContext';
import WalkingGolferSpinner from '../../components/WalkingGolferSpinner';

const Spinner = () => (
  <WalkingGolferSpinner size="sm" variant="light" />
);

const Login: React.FC = () => {
  const navigate = useNavigate();
  const { startNavigation } = useNavigationLoading();
  const { loginWithMember } = useData();
  const { setPageReady } = usePageReady();
  const [email, setEmail] = useState('');
  
  useEffect(() => {
    setPageReady(true);
  }, [setPageReady]);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [devLoading, setDevLoading] = useState(false);
  const [devMemberLoading, setDevMemberLoading] = useState(false);
  const [error, setError] = useState('');
  const [isStaffOrAdmin, setIsStaffOrAdmin] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [showPasswordField, setShowPasswordField] = useState(false);
  const [checkingEmail, setCheckingEmail] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [otpInputs, setOtpInputs] = useState(['', '', '', '', '', '']);
  const otpRefs = useRef<(HTMLInputElement | null)[]>([]);
  
  const isDev = import.meta.env.DEV;
  
  const isPWA = typeof window !== 'undefined' && (
    (window.navigator as any).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );

  const checkStaffAdmin = useCallback(async (emailToCheck: string) => {
    if (!emailToCheck || !emailToCheck.includes('@')) return;
    
    setCheckingEmail(true);
    try {
      const res = await fetch(`/api/auth/check-staff-admin?email=${encodeURIComponent(emailToCheck)}`);
      if (res.ok) {
        const data = await res.json();
        setIsStaffOrAdmin(data.isStaffOrAdmin);
        setHasPassword(data.hasPassword);
        if (data.isStaffOrAdmin && data.hasPassword) {
          setShowPasswordField(true);
        }
      }
    } catch (err) {
      console.error('Failed to check staff/admin status');
    } finally {
      setCheckingEmail(false);
    }
  }, []);

  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      if (email.includes('@')) {
        checkStaffAdmin(email);
      } else {
        setIsStaffOrAdmin(false);
        setHasPassword(false);
        setShowPasswordField(false);
      }
    }, 500);
    
    return () => clearTimeout(debounceTimer);
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
      const res = await fetch('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(email ? { email } : {}),
        credentials: 'include'
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Dev login failed');
      }
      
      const { member } = await res.json();
      loginWithMember(member);
      startNavigation();
      navigate(member.role === 'admin' || member.role === 'staff' ? '/admin' : '/member/dashboard');
    } catch (err: any) {
      setError(err.message || 'Dev login failed');
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
      const res = await fetch('/api/auth/password-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        credentials: 'include'
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Login failed');
      }
      
      loginWithMember(data.member);
      startNavigation();
      navigate(data.member.role === 'admin' || data.member.role === 'staff' ? '/admin' : '/member/dashboard');
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleRequestOTP = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setLoading(true);
    setError('');
    
    try {
      const res = await fetch('/api/auth/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to send login code');
      }
      
      setOtpSent(true);
      setOtpInputs(['', '', '', '', '', '']);
      setTimeout(() => {
        otpRefs.current[0]?.focus();
      }, 100);
    } catch (err: any) {
      setError(err.message || 'Failed to send login code');
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
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
        credentials: 'include'
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Invalid code');
      }
      
      // NOTE: Supabase Auth Session Sync for RLS
      // Since OTP is verified server-side (not via Supabase Auth), we cannot directly
      // establish a Supabase session here. For RLS on the notifications table to work:
      // 1. The server would need to generate Supabase access/refresh tokens via Admin API
      // 2. The server would return these tokens in the response
      // 3. We would call supabase.auth.setSession({ access_token, refresh_token })
      // 
      // Current implementation: Supabase Realtime is used for real-time updates without RLS.
      // If the server returns supabaseSession data in the future, enable the session sync:
      // if (data.supabaseSession?.access_token && data.supabaseSession?.refresh_token) {
      //   const { getSupabase } = await import('../../lib/supabase');
      //   const supabase = getSupabase();
      //   if (supabase) {
      //     await supabase.auth.setSession({
      //       access_token: data.supabaseSession.access_token,
      //       refresh_token: data.supabaseSession.refresh_token,
      //     });
      //   }
      // }
      
      loginWithMember(data.member);
      
      const isStaff = data.member.role === 'admin' || data.member.role === 'staff';
      const destination = isStaff ? '/admin' : '/member/dashboard';
      
      startNavigation();
      if (data.shouldSetupPassword && isStaff) {
        navigate(destination, { state: { showPasswordSetup: true } });
      } else {
        navigate(destination);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to verify code');
      setOtpInputs(['', '', '', '', '', '']);
      otpRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  if (otpSent) {
    return (
      <div className="flex flex-col min-h-screen bg-[#F2F2EC] overflow-x-hidden">
        <div className="flex-1 flex flex-col justify-center px-6 py-12">
          <div className="w-full max-w-sm mx-auto space-y-8">
            <div className="text-center">
              <div className="w-16 h-16 bg-primary text-[#F2F2EC] rounded-full flex items-center justify-center mx-auto text-2xl mb-6 shadow-xl">
                <span className="material-symbols-outlined text-3xl">dialpad</span>
              </div>
              <h2 className="text-3xl font-bold tracking-tight text-primary">
                Enter Your Code
              </h2>
              <p className="mt-4 text-base text-primary/60 font-medium leading-relaxed">
                We sent a 6-digit code to<br />
                <span className="font-bold text-primary">{email}</span>
              </p>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
                <span className="material-symbols-outlined text-lg">error</span>
                {error}
              </div>
            )}

            <div className="bg-white py-8 px-6 shadow-sm rounded-2xl border border-black/5 space-y-6">
              <div className="flex justify-center gap-2">
                {otpInputs.map((digit, idx) => (
                  <input
                    key={idx}
                    ref={(el) => { otpRefs.current[idx] = el; }}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handleOtpChange(idx, e.target.value)}
                    onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                    onPaste={(e) => handleOtpPaste(e, idx)}
                    className="w-12 h-14 text-center text-2xl font-bold rounded-xl border border-black/10 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all text-primary"
                    disabled={loading}
                  />
                ))}
              </div>
              
              {loading && (
                <div className="text-center text-sm text-primary/60">
                  Verifying...
                </div>
              )}
              
              <div className="flex items-center gap-2 text-center justify-center text-sm text-primary/60">
                <span className="material-symbols-outlined text-sm">schedule</span>
                Code expires in 15 minutes
              </div>
              
              <hr className="border-black/5" />
              
              <div className="space-y-2">
                <button
                  onClick={() => handleRequestOTP()}
                  disabled={loading}
                  className="w-full text-center text-sm text-primary font-medium hover:underline transition-colors disabled:opacity-50"
                >
                  Resend code
                </button>
                <button
                  onClick={() => {
                    setOtpSent(false);
                    setOtpInputs(['', '', '', '', '', '']);
                    setError('');
                  }}
                  className="w-full text-center text-sm text-primary/60 hover:text-primary transition-colors"
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
    <div className="flex flex-col min-h-screen bg-[#F2F2EC] overflow-x-hidden">
      <div className="flex-1 flex flex-col justify-center px-6 py-12">
        <div className="w-full max-w-sm mx-auto space-y-8">
            
            <div className="text-center">
                <img src="/assets/logos/EH-guy-icon.webp" alt="Ever House" className="w-16 h-16 mx-auto mb-6 rounded-xl" />
                <h2 className="text-3xl font-bold tracking-tight text-primary">
                    Member's Portal
                </h2>
                <p className="mt-2 text-base text-primary/60 font-medium">
                    {isStaffOrAdmin && hasPassword ? 'Sign in with your password or verification code.' : 'Enter your email to receive a verification code.'}
                </p>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
                <span className="material-symbols-outlined text-lg">error</span>
                {error}
              </div>
            )}

            <div className="bg-white py-8 px-6 shadow-sm rounded-2xl border border-black/5 space-y-4">
                <form onSubmit={showPasswordField && hasPassword ? handlePasswordLogin : handleRequestOTP} className="space-y-4">
                  <div>
                    <input
                      type="email"
                      placeholder="Membership Email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full px-4 py-3 rounded-xl border border-black/10 focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-all text-primary placeholder:text-primary/40"
                      required
                      autoFocus
                    />
                    {checkingEmail && (
                      <p className="text-xs text-primary/40 mt-1 pl-1">Checking...</p>
                    )}
                  </div>
                  
                  {showPasswordField && hasPassword && (
                    <div className="animate-pop-in">
                      <input
                        type="password"
                        placeholder="Password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full px-4 py-3 rounded-xl border border-black/10 focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-all text-primary placeholder:text-primary/40"
                        required
                      />
                    </div>
                  )}
                  
                  {showPasswordField && hasPassword ? (
                    <button
                      type="submit"
                      disabled={loading || !password}
                      className="flex w-full justify-center items-center gap-3 rounded-xl bg-primary px-3 py-4 text-sm font-bold leading-6 text-white shadow-lg hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary transition-all active:scale-[0.98] disabled:opacity-50"
                    >
                      {loading ? <Spinner /> : <span className="material-symbols-outlined">login</span>}
                      {loading ? 'Signing in...' : 'Sign In'}
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={loading || !email.includes('@')}
                      className="flex w-full justify-center items-center gap-3 rounded-xl bg-primary px-3 py-4 text-sm font-bold leading-6 text-white shadow-lg hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary transition-all active:scale-[0.98] disabled:opacity-50"
                    >
                      {loading ? <Spinner /> : <span className="material-symbols-outlined">dialpad</span>}
                      {loading ? 'Sending...' : 'Send Verification Code'}
                    </button>
                  )}
                </form>

                {showPasswordField && hasPassword && (
                  <div className="animate-pop-in">
                    <hr className="border-black/10" />
                    <button
                      type="button"
                      onClick={handleRequestOTP}
                      disabled={loading}
                      className="flex w-full justify-center items-center gap-2 rounded-xl bg-gray-100 px-3 py-3 text-sm font-bold leading-6 text-primary hover:bg-gray-200 transition-all active:scale-[0.98] disabled:opacity-50 mt-4"
                    >
                      <span className="material-symbols-outlined text-lg">dialpad</span>
                      Use Verification Code Instead
                    </button>
                  </div>
                )}
                
                {isDev && (
                  <>
                    <hr className="border-black/10" />
                    <button
                      type="button"
                      onClick={() => handleDevLogin()}
                      disabled={devLoading || devMemberLoading}
                      className="flex w-full justify-center items-center gap-2 rounded-xl bg-amber-500 px-3 py-3 text-sm font-bold leading-6 text-white hover:bg-amber-600 transition-all active:scale-[0.98] disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-lg">developer_mode</span>
                      {devLoading ? 'Logging in...' : 'Dev Login (Nick)'}
                    </button>
                    <p className="text-center text-xs text-amber-600">
                      Development only - logs in as nick@evenhouse.club
                    </p>
                    <button
                      type="button"
                      onClick={() => handleDevLogin('nicholasallanluu@gmail.com')}
                      disabled={devLoading || devMemberLoading}
                      className="flex w-full justify-center items-center gap-2 rounded-xl bg-purple-500 px-3 py-3 text-sm font-bold leading-6 text-white hover:bg-purple-600 transition-all active:scale-[0.98] disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-lg">person</span>
                      {devMemberLoading ? 'Logging in...' : 'Dev Login (Nick Luu Member)'}
                    </button>
                    <p className="text-center text-xs text-purple-600">
                      Development only - logs in as nicholasallanluu@gmail.com
                    </p>
                  </>
                )}
            </div>

            <p className="text-center text-sm text-primary/60 font-medium">
                Not a member?{' '}
                <button onClick={() => { startNavigation(); navigate('/membership'); }} className="font-bold text-primary hover:underline">
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

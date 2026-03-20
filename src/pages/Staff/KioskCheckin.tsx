import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthData } from '../../contexts/DataContext';
import { parseQrCode } from '../../utils/qrCodeParser';
import Icon from '../../components/icons/Icon';

interface Html5QrcodeInstance {
  getState(): number;
  stop(): Promise<void>;
  start(
    camera: { facingMode: string },
    config: { fps: number; qrbox: { width: number; height: number }; aspectRatio: number },
    onSuccess: (decodedText: string) => void,
    onFailure: () => void
  ): Promise<null | void>;
}

type KioskState = 'idle' | 'scanning' | 'processing' | 'success' | 'already_checked_in' | 'error';

interface CheckinResult {
  memberName: string;
  tier: string | null;
  lifetimeVisits: number;
}

const RESET_DELAY_SUCCESS = 4000;
const RESET_DELAY_ERROR = 3000;

const KioskCheckin: React.FC = () => {
  const { actualUser, sessionChecked } = useAuthData();
  const navigate = useNavigate();
  const [state, setState] = useState<KioskState>('idle');
  const [checkinResult, setCheckinResult] = useState<CheckinResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [cameraError, setCameraError] = useState<string | null>(null);

  const [showPasscodeModal, setShowPasscodeModal] = useState(false);
  const [passcodeDigits, setPasscodeDigits] = useState<string[]>(['', '', '', '']);
  const [passcodeError, setPasscodeError] = useState(false);
  const [passcodeChecking, setPasscodeChecking] = useState(false);
  const passcodeInputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const qrScannerRef = useRef<Html5QrcodeInstance | null>(null);
  const hasScannedRef = useRef(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const elementId = useMemo(() => `kiosk-qr-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, []);

  const isStaff = actualUser?.role === 'admin' || actualUser?.role === 'staff';

  const stopScanner = useCallback(async () => {
    if (qrScannerRef.current) {
      try {
        const { Html5QrcodeScannerState } = await import('html5-qrcode');
        const scannerState = qrScannerRef.current.getState();
        if (scannerState === Html5QrcodeScannerState.SCANNING || scannerState === Html5QrcodeScannerState.PAUSED) {
          await qrScannerRef.current.stop();
        }
      } catch (err: unknown) {
        console.error("[Kiosk] Failed to stop scanner:", err);
      } finally {
        qrScannerRef.current = null;
      }
    }
  }, []);

  const startScanner = useCallback(async () => {
    await stopScanner();
    hasScannedRef.current = false;
    setCameraError(null);

    const containerEl = document.getElementById(elementId);
    if (!containerEl) return;

    try {
      const { Html5Qrcode } = await import('html5-qrcode');
      const cameras = await Html5Qrcode.getCameras();
      if (!cameras || cameras.length === 0) {
        setCameraError('No cameras found. Please connect a camera.');
        return;
      }

      const qrScanner = new Html5Qrcode(elementId);
      qrScannerRef.current = qrScanner;

      await qrScanner.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: { width: 280, height: 280 },
          aspectRatio: 1.0,
        },
        (decodedText) => {
          if (!hasScannedRef.current) {
            hasScannedRef.current = true;
            handleScan(decodedText);
          }
        },
        () => {}
      );
    } catch (err: unknown) {
      setCameraError(`Camera error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [elementId, stopScanner]);

  const handleScan = useCallback(async (decodedText: string) => {
    const parsed = parseQrCode(decodedText);
    if (parsed.type !== 'member' || !parsed.memberId) {
      setErrorMessage('Invalid QR code. Please use your membership card QR code.');
      setState('error');
      return;
    }

    setState('processing');

    try {
      const res = await fetch('/api/kiosk/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ memberId: parsed.memberId })
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setCheckinResult({
          memberName: data.memberName,
          tier: data.tier,
          lifetimeVisits: data.lifetimeVisits
        });
        setState('success');
      } else if (data.alreadyCheckedIn) {
        setCheckinResult({
          memberName: data.memberName || '',
          tier: data.tier || null,
          lifetimeVisits: 0
        });
        setState('already_checked_in');
      } else {
        setErrorMessage(data.error || 'Check-in failed. Please ask staff for help.');
        setState('error');
      }
    } catch {
      setErrorMessage('Connection error. Please try again.');
      setState('error');
    }
  }, []);

  const resetToIdle = useCallback(() => {
    stopScanner();
    setState('idle');
    setCheckinResult(null);
    setErrorMessage('');
    hasScannedRef.current = false;
  }, [stopScanner]);

  useEffect(() => {
    if (state === 'success' || state === 'already_checked_in') {
      stopScanner();
      resetTimerRef.current = setTimeout(resetToIdle, RESET_DELAY_SUCCESS);
    } else if (state === 'error') {
      stopScanner();
      resetTimerRef.current = setTimeout(resetToIdle, RESET_DELAY_ERROR);
    }
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, [state, stopScanner, resetToIdle]);

  useEffect(() => {
    return () => {
      stopScanner();
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, [stopScanner]);

  const backBlockerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const blockBackNavigation = () => {
      window.history.pushState(null, '', '/kiosk');
    };

    backBlockerRef.current = blockBackNavigation;

    window.history.replaceState(null, '', '/kiosk');
    window.history.pushState(null, '', '/kiosk');

    window.addEventListener('popstate', blockBackNavigation);

    const blockBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', blockBeforeUnload);

    const blockKeyboardNav = (e: KeyboardEvent) => {
      if (
        (e.metaKey && e.key === 'l') ||
        (e.metaKey && e.key === '[') ||
        (e.metaKey && e.key === ']') ||
        (e.altKey && e.key === 'ArrowLeft') ||
        (e.altKey && e.key === 'ArrowRight') ||
        (e.metaKey && e.key === 'r') ||
        e.key === 'F5'
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', blockKeyboardNav, true);

    const blockContextMenu = (e: Event) => {
      e.preventDefault();
    };
    window.addEventListener('contextmenu', blockContextMenu);

    return () => {
      window.removeEventListener('popstate', blockBackNavigation);
      window.removeEventListener('beforeunload', blockBeforeUnload);
      window.removeEventListener('keydown', blockKeyboardNav, true);
      window.removeEventListener('contextmenu', blockContextMenu);
      backBlockerRef.current = null;
    };
  }, []);

  const handleStartCheckin = useCallback(() => {
    setState('scanning');
    setTimeout(() => startScanner(), 500);
  }, [startScanner]);

  const handlePasscodeOpen = useCallback(() => {
    setShowPasscodeModal(true);
    setPasscodeDigits(['', '', '', '']);
    setPasscodeError(false);
    setPasscodeChecking(false);
    setTimeout(() => passcodeInputRefs.current[0]?.focus(), 100);
  }, []);

  const handlePasscodeClose = useCallback(() => {
    setShowPasscodeModal(false);
    setPasscodeDigits(['', '', '', '']);
    setPasscodeError(false);
  }, []);

  const handlePasscodeSubmit = useCallback(async (digits: string[]) => {
    const code = digits.join('');
    if (code.length !== 4) return;

    setPasscodeChecking(true);
    setPasscodeError(false);

    try {
      const res = await fetch('/api/kiosk/verify-passcode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ passcode: code })
      });

      const data = await res.json();
      if (data.valid) {
        if (backBlockerRef.current) {
          window.removeEventListener('popstate', backBlockerRef.current);
          backBlockerRef.current = null;
        }
        await stopScanner();
        navigate('/admin', { replace: true });
      } else {
        setPasscodeError(true);
        setPasscodeDigits(['', '', '', '']);
        setTimeout(() => passcodeInputRefs.current[0]?.focus(), 100);
      }
    } catch {
      setPasscodeError(true);
      setPasscodeDigits(['', '', '', '']);
      setTimeout(() => passcodeInputRefs.current[0]?.focus(), 100);
    } finally {
      setPasscodeChecking(false);
    }
  }, [navigate, stopScanner]);

  const handlePasscodeDigitChange = useCallback((index: number, value: string) => {
    if (value.length > 1) value = value.slice(-1);
    if (value && !/^\d$/.test(value)) return;

    setPasscodeError(false);
    const newDigits = [...passcodeDigits];
    newDigits[index] = value;
    setPasscodeDigits(newDigits);

    if (value && index < 3) {
      passcodeInputRefs.current[index + 1]?.focus();
    }

    if (value && index === 3) {
      handlePasscodeSubmit(newDigits);
    }
  }, [passcodeDigits, handlePasscodeSubmit]);

  const handlePasscodeKeyDown = useCallback((index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !passcodeDigits[index] && index > 0) {
      const newDigits = [...passcodeDigits];
      newDigits[index - 1] = '';
      setPasscodeDigits(newDigits);
      passcodeInputRefs.current[index - 1]?.focus();
    }
  }, [passcodeDigits]);

  if (!sessionChecked) {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ zIndex: 9999, background: '#293515' }}>
        <div className="w-12 h-12 rounded-full border-4 border-white/20 border-t-[#CCB8E4] animate-spin" />
      </div>
    );
  }

  if (!isStaff) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center px-6" style={{ zIndex: 9999, background: 'linear-gradient(180deg, #293515 0%, #1f2a0f 100%)' }}>
        <div className="w-20 h-20 rounded-2xl bg-red-500/10 flex items-center justify-center mb-6">
          <Icon name="lock" className="text-5xl text-red-400" />
        </div>
        <h1 className="text-2xl font-bold text-white mb-2">Staff Access Required</h1>
        <p className="text-white/50 text-center mb-8">Sign in with a staff account to use kiosk mode.</p>
        <button
          onClick={() => navigate('/admin', { replace: true })}
          className="px-6 py-3 rounded-xl bg-white/10 text-white font-medium hover:bg-white/20 transition-colors"
        >
          Go to Admin Portal
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col select-none" style={{ zIndex: 9999, touchAction: 'none', background: 'linear-gradient(180deg, #293515 0%, #1f2a0f 50%, #1a220c 100%)' }}>
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")` }} />

      <div className="relative flex items-center justify-between px-6 pt-6 pb-4 flex-shrink-0">
        <img
          src="/assets/logos/mascot-white.webp"
          alt="Ever Club"
          className="h-10 w-auto object-contain opacity-80"
        />
        <button
          onClick={handlePasscodeOpen}
          className="w-10 h-10 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors"
          aria-label="Exit kiosk mode"
        >
          <Icon name="lock_open" className="text-white/20 text-base" />
        </button>
      </div>

      <div className="relative flex-1 flex flex-col items-center justify-center px-6">
        {state === 'idle' && (
          <div className="w-full max-w-md flex flex-col items-center animate-in fade-in duration-500">
            <div className="w-24 h-24 rounded-3xl bg-[#CCB8E4]/10 flex items-center justify-center mx-auto mb-6 border border-[#CCB8E4]/20">
              <Icon name="qr_code_scanner" className="text-6xl text-[#CCB8E4]" />
            </div>
            <h1 className="text-4xl font-bold text-white tracking-tight mb-2" style={{ fontFamily: 'var(--font-headline)' }}>Self Check-In</h1>
            <p className="text-white/50 text-lg mb-10 text-center">Tap the button below to scan your membership QR code</p>

            <button
              onClick={handleStartCheckin}
              className="group relative px-10 py-5 rounded-2xl text-[#293515] text-xl font-semibold transition-all duration-200 shadow-lg"
              style={{ background: '#CCB8E4', boxShadow: '0 8px 32px rgba(204, 184, 228, 0.3)' }}
            >
              <span className="flex items-center gap-3">
                <Icon name="photo_camera" className="text-2xl" />
                Start Check-In
              </span>
            </button>
          </div>
        )}

        {state === 'scanning' && (
          <div className="w-full max-w-md flex flex-col items-center animate-in fade-in duration-300">
            <div className="mb-8 text-center">
              <h1 className="text-3xl font-bold text-white tracking-tight" style={{ fontFamily: 'var(--font-headline)' }}>Welcome</h1>
              <p className="text-white/50 mt-2 text-lg">Scan your membership QR code to check in</p>
            </div>

            <div className="w-full max-w-sm relative rounded-2xl overflow-hidden bg-black/30 border border-white/10">
              <div id={elementId} className="w-full" style={{ minHeight: 350 }} />
              {cameraError && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-6">
                  <div className="text-center">
                    <Icon name="photo_camera" className="text-4xl text-red-400 mb-3" />
                    <p className="text-red-300 text-sm">{cameraError}</p>
                    <button
                      onClick={() => startScanner()}
                      className="mt-4 px-4 py-2 rounded-lg bg-white/10 text-white text-sm hover:bg-white/20 transition-colors"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              )}
            </div>

            <p className="text-white/30 text-xs mt-6">Hold your QR code up to the camera</p>
          </div>
        )}

        {state === 'processing' && (
          <div className="text-center animate-in fade-in duration-200">
            <div className="w-20 h-20 rounded-full bg-white/10 flex items-center justify-center mx-auto mb-6">
              <div className="w-10 h-10 rounded-full border-4 border-white/20 border-t-[#CCB8E4] animate-spin" />
            </div>
            <h2 className="text-2xl font-bold text-white" style={{ fontFamily: 'var(--font-headline)' }}>Checking you in...</h2>
            <p className="text-white/40 mt-2">Just a moment</p>
          </div>
        )}

        {state === 'success' && checkinResult && (
          <div className="text-center animate-in fade-in zoom-in-95 duration-500">
            <div className="w-24 h-24 rounded-full bg-emerald-500/20 flex items-center justify-center mx-auto mb-6">
              <Icon name="check_circle" className="text-6xl text-emerald-400" />
            </div>
            <h2 className="text-3xl font-bold text-white mb-2" style={{ fontFamily: 'var(--font-headline)' }}>Welcome back!</h2>
            <p className="text-[#CCB8E4] text-2xl font-semibold">{checkinResult.memberName}</p>
            {checkinResult.tier && (
              <span className="inline-block mt-3 px-4 py-1.5 rounded-full bg-white/10 text-white/70 text-sm font-medium">
                {checkinResult.tier}
              </span>
            )}
            {checkinResult.lifetimeVisits > 0 && (
              <p className="text-white/40 text-sm mt-4">
                Visit #{checkinResult.lifetimeVisits}
              </p>
            )}
          </div>
        )}

        {state === 'already_checked_in' && checkinResult && (
          <div className="text-center animate-in fade-in zoom-in-95 duration-500">
            <div className="w-24 h-24 rounded-full bg-amber-500/20 flex items-center justify-center mx-auto mb-6">
              <Icon name="check_circle" className="text-6xl text-amber-400" />
            </div>
            <h2 className="text-3xl font-bold text-white mb-2" style={{ fontFamily: 'var(--font-headline)' }}>Already Checked In</h2>
            {checkinResult.memberName && (
              <p className="text-amber-400 text-2xl font-semibold">{checkinResult.memberName}</p>
            )}
            <p className="text-white/40 text-sm mt-4">You were recently checked in</p>
          </div>
        )}

        {state === 'error' && (
          <div className="text-center animate-in fade-in zoom-in-95 duration-300">
            <div className="w-24 h-24 rounded-full bg-red-500/20 flex items-center justify-center mx-auto mb-6">
              <Icon name="warning" className="text-6xl text-red-400" />
            </div>
            <h2 className="text-2xl font-bold text-white mb-2" style={{ fontFamily: 'var(--font-headline)' }}>Check-In Issue</h2>
            <p className="text-red-300 text-lg">{errorMessage}</p>
            <p className="text-white/30 text-sm mt-4">Please ask staff for assistance</p>
          </div>
        )}
      </div>

      <div className="relative pb-6 text-center">
        <p className="text-white/15 text-xs tracking-wider uppercase" style={{ fontFamily: 'var(--font-label)' }}>Ever Club</p>
      </div>

      {showPasscodeModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-[10000] animate-in fade-in duration-200">
          <div className="rounded-2xl p-8 w-full max-w-sm mx-6 border border-white/10 animate-in zoom-in-95 duration-300" style={{ background: 'linear-gradient(180deg, #293515 0%, #1f2a0f 100%)' }}>
            <div className="text-center mb-8">
              <div className="w-14 h-14 rounded-xl bg-[#CCB8E4]/10 border border-[#CCB8E4]/20 flex items-center justify-center mx-auto mb-4">
                <Icon name="lock" className="text-3xl text-[#CCB8E4]/70" />
              </div>
              <h2 className="text-xl font-bold text-white mb-1" style={{ fontFamily: 'var(--font-headline)' }}>Enter Passcode</h2>
              <p className="text-white/40 text-sm">Staff passcode to exit kiosk mode</p>
            </div>

            <div className="flex justify-center gap-3 mb-6">
              {passcodeDigits.map((digit, i) => (
                <input
                  key={i}
                  ref={el => { passcodeInputRefs.current[i] = el; }}
                  type="password"
                  inputMode="numeric"
                  maxLength={1}
                  value={digit}
                  onChange={e => handlePasscodeDigitChange(i, e.target.value)}
                  onKeyDown={e => handlePasscodeKeyDown(i, e)}
                  disabled={passcodeChecking}
                  className={`w-14 h-16 text-center text-2xl font-bold rounded-xl border-2 bg-black/30 text-white outline-none transition-all duration-200 ${
                    passcodeError
                      ? 'border-red-500 animate-shake'
                      : digit
                        ? 'border-[#CCB8E4]/50'
                        : 'border-white/20 focus:border-[#CCB8E4]/40'
                  } disabled:opacity-50`}
                  autoComplete="off"
                />
              ))}
            </div>

            {passcodeError && (
              <p className="text-red-400 text-sm text-center mb-4 animate-in fade-in duration-200">
                Incorrect passcode. Try again.
              </p>
            )}

            {passcodeChecking && (
              <div className="flex justify-center mb-4">
                <div className="w-6 h-6 rounded-full border-2 border-white/20 border-t-[#CCB8E4] animate-spin" />
              </div>
            )}

            <button
              onClick={handlePasscodeClose}
              className="w-full py-3 rounded-xl bg-white/5 hover:bg-white/10 text-white/60 text-sm font-medium transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default KioskCheckin;

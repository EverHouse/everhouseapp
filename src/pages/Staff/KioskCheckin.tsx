import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthData } from '../../contexts/DataContext';
import { parseQrCode } from '../../utils/qrCodeParser';
import Icon from '../../components/icons/Icon';
import { MemberPaymentModal } from '../../components/booking/MemberPaymentModal';

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

interface UpcomingBooking {
  bookingId: number;
  sessionId: number | null;
  startTime: string;
  endTime: string;
  resourceName: string;
  resourceType: string;
  declaredPlayerCount: number;
  ownerEmail: string;
  ownerName: string;
  unpaidFeeCents: number;
}

interface CheckinResult {
  memberName: string;
  tier: string | null;
  lifetimeVisits: number;
  upcomingBooking?: UpcomingBooking | null;
}

const ACCENT = '#CCB8E4';
const BG_GRADIENT = 'radial-gradient(ellipse at 50% 40%, #2f3d1a 0%, #1a220c 60%, #0d1106 100%)';
const RESET_DELAY_SUCCESS = 5000;
const RESET_DELAY_WITH_BOOKING = 25000;
const RESET_DELAY_ERROR = 3000;

function getPacificGreeting(): string {
  const h = parseInt(
    new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }),
    10
  );
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function formatTime12h(time24: string): string {
  if (!time24) return '';
  const [h, m] = time24.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 || 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

const KioskCheckin: React.FC = () => {
  const { actualUser, sessionChecked } = useAuthData();
  const navigate = useNavigate();
  const [state, setState] = useState<KioskState>('idle');
  const [checkinResult, setCheckinResult] = useState<CheckinResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);

  const [showPasscodeModal, setShowPasscodeModal] = useState(false);
  const [passcodeDigits, setPasscodeDigits] = useState<string[]>(['', '', '', '']);
  const [passcodeError, setPasscodeError] = useState(false);
  const [passcodeChecking, setPasscodeChecking] = useState(false);
  const passcodeInputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const passcodeDigitsRef = useRef<string[]>(['', '', '', '']);
  passcodeDigitsRef.current = passcodeDigits;

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
          lifetimeVisits: data.lifetimeVisits,
          upcomingBooking: data.upcomingBooking || null
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

  const scannerStartedRef = useRef(false);

  const startScanner = useCallback(async () => {
    await stopScanner();
    hasScannedRef.current = false;
    scannerStartedRef.current = false;
    setCameraError(null);

    const containerEl = document.getElementById(elementId);
    if (!containerEl) return;

    const initTimeout = setTimeout(() => {
      if (!scannerStartedRef.current) {
        setCameraError('Camera took too long to initialize. Please try again.');
      }
    }, 10000);

    try {
      const { Html5Qrcode } = await import('html5-qrcode');
      const cameras = await Html5Qrcode.getCameras();
      if (!cameras || cameras.length === 0) {
        clearTimeout(initTimeout);
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
      scannerStartedRef.current = true;
      clearTimeout(initTimeout);
    } catch (err: unknown) {
      clearTimeout(initTimeout);
      setCameraError(`Camera error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [elementId, stopScanner, handleScan]);

  const resetToIdle = useCallback(() => {
    stopScanner();
    setState('idle');
    setCheckinResult(null);
    setErrorMessage('');
    setShowPaymentModal(false);
    hasScannedRef.current = false;
  }, [stopScanner]);

  useEffect(() => {
    if (showPaymentModal) return;
    if (state === 'success' || state === 'already_checked_in') {
      stopScanner();
      const delay = checkinResult?.upcomingBooking ? RESET_DELAY_WITH_BOOKING : RESET_DELAY_SUCCESS;
      resetTimerRef.current = setTimeout(resetToIdle, delay);
    } else if (state === 'error') {
      stopScanner();
      resetTimerRef.current = setTimeout(resetToIdle, RESET_DELAY_ERROR);
    }
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, [state, stopScanner, resetToIdle, showPaymentModal, checkinResult?.upcomingBooking]);

  useEffect(() => {
    return () => {
      stopScanner();
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
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

  const rafRef = useRef<number | null>(null);

  const handleStartCheckin = useCallback(() => {
    setState('scanning');
    let attempts = 0;
    const waitForElement = () => {
      const el = document.getElementById(elementId);
      if (el) {
        rafRef.current = null;
        startScanner();
      } else if (attempts < 60) {
        attempts++;
        rafRef.current = requestAnimationFrame(waitForElement);
      }
    };
    rafRef.current = requestAnimationFrame(waitForElement);
  }, [startScanner, elementId]);

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
    setPasscodeDigits(prev => {
      const newDigits = [...prev];
      newDigits[index] = value;
      return newDigits;
    });

    if (value && index < 3) {
      setTimeout(() => passcodeInputRefs.current[index + 1]?.focus(), 0);
    }
  }, []);

  const handlePasscodeKeyDown = useCallback((index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (/^\d$/.test(e.key)) {
      e.preventDefault();
      setPasscodeError(false);
      setPasscodeDigits(prev => {
        const newDigits = [...prev];
        newDigits[index] = e.key;
        return newDigits;
      });
      if (index < 3) {
        setTimeout(() => passcodeInputRefs.current[index + 1]?.focus(), 0);
      }
      return;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      const currentDigit = passcodeDigitsRef.current[index];
      if (currentDigit) {
        setPasscodeDigits(prev => {
          const newDigits = [...prev];
          newDigits[index] = '';
          return newDigits;
        });
      } else if (index > 0) {
        setPasscodeDigits(prev => {
          const newDigits = [...prev];
          newDigits[index - 1] = '';
          return newDigits;
        });
        setTimeout(() => passcodeInputRefs.current[index - 1]?.focus(), 0);
      }
      return;
    }
    if (e.key === 'Enter') {
      handlePasscodeSubmit(passcodeDigitsRef.current);
    }
  }, [handlePasscodeSubmit]);

  if (!sessionChecked) {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ zIndex: 9999, background: BG_GRADIENT }}>
        <div className="w-12 h-12 rounded-full border-4 border-white/20 animate-spin" style={{ borderTopColor: ACCENT }} />
      </div>
    );
  }

  if (!isStaff) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center px-6" style={{ zIndex: 9999, background: BG_GRADIENT }}>
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

  const booking = checkinResult?.upcomingBooking;
  const firstName = checkinResult?.memberName?.split(' ')[0] || '';

  return (
    <div className="fixed inset-0 flex flex-col select-none" style={{ zIndex: 9999, touchAction: 'none', background: BG_GRADIENT }}>
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")` }} />

      <div className="relative flex items-center justify-center px-6 pt-6 pb-4 flex-shrink-0">
        <img
          src="/assets/logos/mascot-white.webp"
          alt="Ever Club"
          className="h-10 w-auto object-contain opacity-80"
        />
        <button
          onClick={handlePasscodeOpen}
          className="absolute right-6 w-10 h-10 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors"
          aria-label="Exit kiosk mode"
        >
          <Icon name="lock_open" className="text-white/20 text-base" />
        </button>
      </div>

      <div className="relative flex-1 flex flex-col items-center justify-center px-6">
        {state === 'idle' && (
          <div className="w-full max-w-md flex flex-col items-center animate-in fade-in duration-500 relative">
            <div
              className="absolute w-72 h-72 rounded-full pointer-events-none"
              style={{ background: `radial-gradient(circle, rgba(204,184,228,0.08) 0%, transparent 70%)`, top: '-40px' }}
            />

            <div
              className="relative w-24 h-24 rounded-3xl flex items-center justify-center mx-auto mb-6"
              style={{ background: `rgba(204,184,228,0.08)`, border: `1px solid rgba(204,184,228,0.25)` }}
            >
              <Icon name="qr_code_scanner" className="text-6xl" style={{ color: ACCENT }} />
            </div>
            <h1 className="text-4xl font-bold text-white tracking-tight mb-2" style={{ fontFamily: 'var(--font-headline)' }}>Self Check-In</h1>
            <p className="text-white/50 text-lg mb-10 text-center">Tap the button below to scan your membership QR code</p>

            <button
              onClick={handleStartCheckin}
              className="tactile-btn group relative px-10 py-5 rounded-2xl text-xl font-semibold transition-all duration-200"
              style={{
                background: 'transparent',
                border: `1.5px solid ${ACCENT}`,
                color: '#fff'
              }}
            >
              <span className="flex items-center gap-3">
                <Icon name="photo_camera" className="text-2xl" style={{ color: ACCENT }} />
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
              <div className="w-10 h-10 rounded-full border-4 border-white/20 animate-spin" style={{ borderTopColor: ACCENT }} />
            </div>
            <h2 className="text-2xl font-bold text-white" style={{ fontFamily: 'var(--font-headline)' }}>Checking you in...</h2>
            <p className="text-white/40 mt-2">Just a moment</p>
          </div>
        )}

        {state === 'success' && checkinResult && (
          <div className="text-center animate-in fade-in zoom-in-95 duration-500 w-full max-w-md">
            <div className="w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-6" style={{ background: 'rgba(16,185,129,0.15)' }}>
              <Icon name="check_circle" className="text-6xl text-emerald-400" />
            </div>
            <h2 className="text-3xl font-bold text-white mb-2" style={{ fontFamily: 'var(--font-headline)' }}>
              {getPacificGreeting()}, {firstName}
            </h2>
            <p className="text-2xl font-semibold" style={{ color: ACCENT }}>{checkinResult.memberName}</p>
            {checkinResult.tier && (
              <span
                className="inline-block mt-3 px-4 py-1.5 rounded-full text-sm font-medium"
                style={{
                  background: 'rgba(204,184,228,0.1)',
                  border: '1px solid rgba(204,184,228,0.3)',
                  color: ACCENT,
                  boxShadow: '0 0 12px rgba(204,184,228,0.15)'
                }}
              >
                {checkinResult.tier}
              </span>
            )}
            {checkinResult.lifetimeVisits > 0 && (
              <p className="text-white/40 text-sm mt-3">
                Visit #{checkinResult.lifetimeVisits}
              </p>
            )}

            {booking && (
              <div
                className="mt-6 rounded-2xl p-5 text-left backdrop-blur-xl animate-in fade-in slide-in-from-bottom-2 duration-500"
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.2)'
                }}
              >
                <div className="flex items-center gap-2 mb-3">
                  <Icon name="event" className="text-lg" style={{ color: ACCENT }} />
                  <span className="text-white/70 text-sm font-medium">Upcoming Booking</span>
                </div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-white font-semibold text-lg">{booking.resourceName}</span>
                  <span className="text-white/60 text-sm">
                    {booking.declaredPlayerCount} {booking.declaredPlayerCount === 1 ? 'player' : 'players'}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-white/50 text-sm mb-1">
                  <Icon name="schedule" className="text-sm" style={{ color: ACCENT }} />
                  <span>{formatTime12h(booking.startTime)} – {formatTime12h(booking.endTime)}</span>
                </div>

                {booking.unpaidFeeCents > 0 && booking.sessionId && (
                  <div className="mt-4 pt-4" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                    <div className="flex items-center justify-between">
                      <span className="text-white/50 text-sm">
                        Fees due: <span className="text-white font-medium">${(booking.unpaidFeeCents / 100).toFixed(2)}</span>
                      </span>
                      <button
                        onClick={() => setShowPaymentModal(true)}
                        className="tactile-btn px-5 py-2 rounded-xl text-sm font-semibold transition-all duration-200"
                        style={{ background: ACCENT, color: '#293515' }}
                      >
                        Pay Now
                      </button>
                    </div>
                  </div>
                )}
              </div>
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

      <div className="relative pb-6 flex justify-center">
        <img
          src="/images/everclub-logo-light.webp"
          alt="Ever Club"
          className="h-5 opacity-15"
        />
      </div>

      {showPasscodeModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-[10000] animate-in fade-in duration-200">
          <div
            className="rounded-2xl p-8 w-full max-w-sm mx-6 backdrop-blur-xl animate-in zoom-in-95 duration-300"
            style={{
              background: 'rgba(30,40,15,0.85)',
              border: '1px solid rgba(255,255,255,0.12)',
              boxShadow: '0 24px 48px rgba(0,0,0,0.4)'
            }}
          >
            <div className="text-center mb-8">
              <div
                className="w-14 h-14 rounded-xl flex items-center justify-center mx-auto mb-4"
                style={{ background: 'rgba(204,184,228,0.1)', border: '1px solid rgba(204,184,228,0.2)' }}
              >
                <Icon name="lock" className="text-3xl" style={{ color: `${ACCENT}B3` }} />
              </div>
              <h2 className="text-xl font-bold text-white mb-1" style={{ fontFamily: 'var(--font-headline)' }}>Enter Passcode</h2>
              <p className="text-white/40 text-sm">Staff passcode to exit kiosk mode</p>
            </div>

            <div className="flex justify-center gap-3 mb-6">
              {passcodeDigits.map((digit, i) => (
                <input
                  key={i}
                  ref={el => { passcodeInputRefs.current[i] = el; }}
                  type="tel"
                  inputMode="numeric"
                  pattern="[0-9]*"
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
                        : 'border-white/15 focus:border-[#CCB8E4]/40'
                  } disabled:opacity-50`}
                  autoComplete="off"
                  style={{ WebkitTextSecurity: 'disc' } as React.CSSProperties}
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
                <div className="w-6 h-6 rounded-full border-2 border-white/20 animate-spin" style={{ borderTopColor: ACCENT }} />
              </div>
            )}

            <button
              onClick={() => handlePasscodeSubmit(passcodeDigits)}
              disabled={passcodeChecking || passcodeDigits.some(d => !d)}
              className="w-full py-3 rounded-xl font-medium text-sm transition-all duration-200 disabled:opacity-30 mb-2"
              style={{ background: ACCENT, color: '#293515' }}
            >
              {passcodeChecking ? 'Verifying...' : 'Submit'}
            </button>

            <button
              onClick={handlePasscodeClose}
              className="w-full py-3 rounded-xl bg-white/5 hover:bg-white/10 text-white/60 text-sm font-medium transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {showPaymentModal && booking && booking.sessionId && (
        <MemberPaymentModal
          isOpen={showPaymentModal}
          bookingId={booking.bookingId}
          sessionId={booking.sessionId}
          ownerEmail={booking.ownerEmail}
          ownerName={booking.ownerName}
          onSuccess={() => {
            setShowPaymentModal(false);
            resetToIdle();
          }}
          onClose={() => setShowPaymentModal(false)}
        />
      )}
    </div>
  );
};

export default KioskCheckin;

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

const OLIVE_ACCENT = '#8B9A6B';
const OLIVE_TEXT = '#C4CFA6';
const CREAM = '#E8E4D9';
const BG_GRADIENT = 'radial-gradient(ellipse at 50% 30%, #2a3518 0%, #1a220c 50%, #0d1106 100%)';
const CARD_BG = 'rgba(35, 45, 20, 0.6)';
const CARD_BORDER = 'rgba(139, 154, 107, 0.25)';
const RESET_DELAY_SUCCESS = 6000;
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
  const [passcodeErrorMessage, setPasscodeErrorMessage] = useState('');
  const [passcodeChecking, setPasscodeChecking] = useState(false);
  const passcodeInputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const passcodeDigitsRef = useRef<string[]>(['', '', '', '']);
  passcodeDigitsRef.current = passcodeDigits;

  const qrScannerRef = useRef<Html5QrcodeInstance | null>(null);
  const hasScannedRef = useRef(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const passcodeSubmitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const passcodeSubmittingRef = useRef(false);

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
    setPasscodeErrorMessage('');
    setPasscodeChecking(false);
    passcodeSubmittingRef.current = false;
    if (passcodeSubmitTimerRef.current) { clearTimeout(passcodeSubmitTimerRef.current); passcodeSubmitTimerRef.current = null; }
    setTimeout(() => passcodeInputRefs.current[0]?.focus(), 100);
  }, []);

  const handlePasscodeClose = useCallback(() => {
    setShowPasscodeModal(false);
    setPasscodeDigits(['', '', '', '']);
    setPasscodeError(false);
    setPasscodeErrorMessage('');
    passcodeSubmittingRef.current = false;
    if (passcodeSubmitTimerRef.current) { clearTimeout(passcodeSubmitTimerRef.current); passcodeSubmitTimerRef.current = null; }
  }, []);

  const handlePasscodeSubmit = useCallback(async (digits: string[]) => {
    const code = digits.join('');
    if (code.length !== 4) return;
    if (passcodeSubmittingRef.current) return;
    passcodeSubmittingRef.current = true;

    if (passcodeSubmitTimerRef.current) {
      clearTimeout(passcodeSubmitTimerRef.current);
      passcodeSubmitTimerRef.current = null;
    }

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
        setPasscodeErrorMessage(data.error || 'Incorrect passcode. Try again.');
        setPasscodeDigits(['', '', '', '']);
        setTimeout(() => passcodeInputRefs.current[0]?.focus(), 100);
      }
    } catch {
      setPasscodeError(true);
      setPasscodeErrorMessage('Connection error. Please try again.');
      setPasscodeDigits(['', '', '', '']);
      setTimeout(() => passcodeInputRefs.current[0]?.focus(), 100);
    } finally {
      setPasscodeChecking(false);
      passcodeSubmittingRef.current = false;
    }
  }, [navigate, stopScanner]);

  const handlePasscodeDigitChange = useCallback((index: number, value: string) => {
    if (value.length > 1) value = value.slice(-1);
    if (value && !/^\d$/.test(value)) return;

    setPasscodeError(false);
    const newDigits = [...passcodeDigitsRef.current];
    newDigits[index] = value;
    setPasscodeDigits(newDigits);

    if (value && index < 3) {
      setTimeout(() => passcodeInputRefs.current[index + 1]?.focus(), 0);
    } else if (value && index === 3 && newDigits.every(d => d !== '')) {
      if (passcodeSubmitTimerRef.current) clearTimeout(passcodeSubmitTimerRef.current);
      passcodeSubmitTimerRef.current = setTimeout(() => handlePasscodeSubmit(newDigits), 50);
    }
  }, [handlePasscodeSubmit]);

  const handlePasscodeKeyDown = useCallback((index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (/^\d$/.test(e.key)) {
      e.preventDefault();
      setPasscodeError(false);
      setPasscodeErrorMessage('');
      const newDigits = [...passcodeDigitsRef.current];
      newDigits[index] = e.key;
      setPasscodeDigits(newDigits);
      if (index < 3) {
        setTimeout(() => passcodeInputRefs.current[index + 1]?.focus(), 0);
      } else if (newDigits.every(d => d !== '')) {
        if (passcodeSubmitTimerRef.current) clearTimeout(passcodeSubmitTimerRef.current);
        passcodeSubmitTimerRef.current = setTimeout(() => handlePasscodeSubmit(newDigits), 50);
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

  const currentPacificTime = useMemo(() => {
    return new Date().toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: 'numeric',
      minute: '2-digit',
      hour12: false
    });
  }, [state]);

  if (!sessionChecked) {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ zIndex: 9999, background: BG_GRADIENT }}>
        <div className="w-12 h-12 rounded-full border-4 border-white/20 animate-spin" style={{ borderTopColor: OLIVE_ACCENT }} />
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

      <div className="relative flex items-center justify-between px-8 pt-6 pb-4 flex-shrink-0">
        <img
          src="/assets/logos/mascot-white.webp"
          alt="Ever Club"
          className="h-8 w-auto object-contain opacity-60"
        />
        <button
          onClick={handlePasscodeOpen}
          className="w-10 h-10 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors"
          aria-label="Exit kiosk mode"
        >
          <Icon name="lock_open" className="text-white/15 text-base" />
        </button>
      </div>

      <div className="relative flex-1 flex flex-col items-center justify-center px-6 overflow-hidden min-h-0">

        {state === 'idle' && (
          <div className="w-full max-w-lg flex flex-col items-center animate-in fade-in duration-700 relative">
            <p
              className="text-xs font-semibold tracking-[0.3em] uppercase mb-4"
              style={{ color: OLIVE_ACCENT }}
            >
              Arrival Protocol
            </p>

            <h1
              className="text-4xl md:text-5xl text-center leading-[1.1] mb-2"
              style={{ fontFamily: 'var(--font-headline)', color: CREAM }}
            >
              Welcome to
            </h1>
            <img
              src="/images/everclub-logo-light.webp"
              alt="Ever Club"
              className="h-14 md:h-18 w-auto object-contain mx-auto mb-3 opacity-90"
              style={{ filter: 'brightness(1.3)' }}
            />

            <p className="text-white/45 text-sm text-center max-w-xs mb-6 leading-relaxed">
              Please present your digital key or scan the physical portal code.
            </p>

            <div
              className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-medium tracking-wider uppercase mb-6"
              style={{ background: 'rgba(139, 154, 107, 0.12)', border: `1px solid ${CARD_BORDER}`, color: OLIVE_TEXT }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Secure Link Active
            </div>

            <div className="relative w-52 h-52 md:w-64 md:h-64 flex items-center justify-center mb-6">
              <div className="absolute top-0 left-0 w-7 h-7 border-t-2 border-l-2" style={{ borderColor: OLIVE_ACCENT }} />
              <div className="absolute top-0 right-0 w-7 h-7 border-t-2 border-r-2" style={{ borderColor: OLIVE_ACCENT }} />
              <div className="absolute bottom-0 left-0 w-7 h-7 border-b-2 border-l-2" style={{ borderColor: OLIVE_ACCENT }} />
              <div className="absolute bottom-0 right-0 w-7 h-7 border-b-2 border-r-2" style={{ borderColor: OLIVE_ACCENT }} />

              <div className="flex flex-col items-center gap-3">
                <Icon name="qr_code_scanner" className="text-6xl" style={{ color: 'rgba(139, 154, 107, 0.4)' }} />
                <p
                  className="text-[10px] tracking-[0.25em] uppercase font-medium"
                  style={{ color: 'rgba(139, 154, 107, 0.5)' }}
                >
                  Aligning Sensors
                </p>
              </div>
            </div>

            <button
              onClick={handleStartCheckin}
              className="tactile-btn group relative w-full max-w-xs py-3.5 rounded-xl text-lg font-semibold transition-all duration-300"
              style={{
                background: 'rgba(139, 154, 107, 0.15)',
                border: `1px solid ${CARD_BORDER}`,
                color: CREAM
              }}
            >
              <span className="flex items-center justify-center gap-2">
                Start Check-In
                <Icon name="chevron_right" className="text-xl" style={{ color: OLIVE_ACCENT }} />
              </span>
            </button>
          </div>
        )}

        {state === 'scanning' && (
          <div className="w-full max-w-lg flex flex-col items-center animate-in fade-in duration-300">
            <p
              className="text-xs font-semibold tracking-[0.3em] uppercase mb-3"
              style={{ color: OLIVE_ACCENT }}
            >
              Arrival Protocol
            </p>
            <h1
              className="text-3xl md:text-4xl text-center leading-[1.1] mb-2"
              style={{ fontFamily: 'var(--font-headline)', color: CREAM }}
            >
              Present Your Key
            </h1>
            <p className="text-white/40 text-sm mb-4 text-center">Hold your membership QR code to the camera</p>

            <div
              className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-medium tracking-wider uppercase mb-4"
              style={{ background: 'rgba(139, 154, 107, 0.12)', border: `1px solid ${CARD_BORDER}`, color: OLIVE_TEXT }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Scanner Active
            </div>

            <div className="relative w-full max-w-sm">
              <div className="absolute -top-2 -left-2 w-7 h-7 border-t-2 border-l-2 z-10" style={{ borderColor: OLIVE_ACCENT }} />
              <div className="absolute -top-2 -right-2 w-7 h-7 border-t-2 border-r-2 z-10" style={{ borderColor: OLIVE_ACCENT }} />
              <div className="absolute -bottom-2 -left-2 w-7 h-7 border-b-2 border-l-2 z-10" style={{ borderColor: OLIVE_ACCENT }} />
              <div className="absolute -bottom-2 -right-2 w-7 h-7 border-b-2 border-r-2 z-10" style={{ borderColor: OLIVE_ACCENT }} />

              <div className="rounded-lg overflow-hidden bg-black/40" style={{ border: `1px solid ${CARD_BORDER}` }}>
                <div id={elementId} className="w-full" style={{ height: 'min(350px, 45vh)' }} />
              </div>

              {cameraError && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80 rounded-lg p-6">
                  <div className="text-center">
                    <Icon name="photo_camera" className="text-4xl text-red-400 mb-3" />
                    <p className="text-red-300 text-sm">{cameraError}</p>
                    <button
                      onClick={() => startScanner()}
                      className="mt-4 px-4 py-2 rounded-lg text-white text-sm transition-colors"
                      style={{ background: 'rgba(139, 154, 107, 0.2)', border: `1px solid ${CARD_BORDER}` }}
                    >
                      Retry
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {state === 'processing' && (
          <div className="text-center animate-in fade-in duration-200">
            <p
              className="text-xs font-semibold tracking-[0.3em] uppercase mb-6"
              style={{ color: OLIVE_ACCENT }}
            >
              Verifying Identity
            </p>
            <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6" style={{ background: 'rgba(139, 154, 107, 0.1)', border: `1px solid ${CARD_BORDER}` }}>
              <div className="w-10 h-10 rounded-full border-3 border-white/15 animate-spin" style={{ borderTopColor: OLIVE_ACCENT }} />
            </div>
            <h2 className="text-3xl mb-2" style={{ fontFamily: 'var(--font-headline)', color: CREAM }}>
              Confirming your arrival...
            </h2>
            <p className="text-white/35 text-sm">One moment, please</p>
          </div>
        )}

        {state === 'success' && checkinResult && (
          <div className="animate-in fade-in duration-700 w-full max-w-2xl px-2">
            <div className="mb-8">
              <p
                className="text-xs font-semibold tracking-[0.3em] uppercase mb-4"
                style={{ color: OLIVE_ACCENT }}
              >
                Confirmed Access
              </p>

              <div className="flex items-start justify-between flex-wrap gap-4">
                <h2
                  className="text-4xl md:text-5xl leading-[1.1] max-w-md"
                  style={{ fontFamily: 'var(--font-headline)', color: CREAM }}
                >
                  Welcome home,{' '}<em>{firstName}.</em>{' '}
                  <span className="text-white/60">Your sanctuary is prepared.</span>
                </h2>

                <div className="text-right flex-shrink-0 mt-2">
                  <p className="text-[10px] tracking-[0.2em] uppercase mb-1" style={{ color: OLIVE_ACCENT }}>Arrival Protocol</p>
                  <p className="text-white font-semibold text-lg">{currentPacificTime} — PT</p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr] gap-4 mb-6">
              <div
                className="rounded-xl p-6 row-span-2"
                style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
              >
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h3 className="text-lg font-semibold text-white" style={{ fontFamily: 'var(--font-headline)' }}>Digital Identity</h3>
                    <p className="text-[10px] tracking-[0.15em] uppercase mt-0.5" style={{ color: 'rgba(255,255,255,0.35)' }}>Non-Transferable Member Pass</p>
                  </div>
                  <Icon name="verified" className="text-xl" style={{ color: OLIVE_ACCENT }} />
                </div>

                <div className="flex items-center justify-between py-4" style={{ borderTop: `1px solid ${CARD_BORDER}`, borderBottom: `1px solid ${CARD_BORDER}` }}>
                  <div>
                    <p className="text-[10px] tracking-[0.15em] uppercase mb-1" style={{ color: 'rgba(255,255,255,0.35)' }}>Member</p>
                    <p className="text-white text-lg font-semibold">{checkinResult.memberName}</p>
                  </div>
                  <span
                    className="px-3 py-1 rounded-full text-[10px] font-semibold tracking-wider uppercase"
                    style={{ background: 'rgba(16, 185, 129, 0.15)', color: '#6ee7b7', border: '1px solid rgba(16, 185, 129, 0.25)' }}
                  >
                    Verified
                  </span>
                </div>

                {checkinResult.tier && (
                  <div className="flex items-center justify-between pt-4">
                    <div>
                      <p className="text-[10px] tracking-[0.15em] uppercase mb-1" style={{ color: 'rgba(255,255,255,0.35)' }}>Tier</p>
                      <p className="text-white font-medium">{checkinResult.tier}</p>
                    </div>
                    {checkinResult.lifetimeVisits > 0 && (
                      <div className="text-right">
                        <p className="text-[10px] tracking-[0.15em] uppercase mb-1" style={{ color: 'rgba(255,255,255,0.35)' }}>Lifetime Visits</p>
                        <p className="text-white font-medium">{checkinResult.lifetimeVisits}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {booking ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl p-5" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
                      <p className="text-[10px] tracking-[0.15em] uppercase mb-2" style={{ color: OLIVE_ACCENT }}>Session Time</p>
                      <p className="text-white text-lg font-bold">{formatTime12h(booking.startTime)}</p>
                      <p className="text-white/40 text-xs mt-0.5">to {formatTime12h(booking.endTime)}</p>
                    </div>
                    <div className="rounded-xl p-5" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
                      <p className="text-[10px] tracking-[0.15em] uppercase mb-2" style={{ color: OLIVE_ACCENT }}>Party Size</p>
                      <p className="text-white text-lg font-bold">
                        {String(booking.declaredPlayerCount).padStart(2, '0')} {booking.declaredPlayerCount === 1 ? 'Guest' : 'Guests'}
                      </p>
                      <p className="text-white/40 text-xs mt-0.5">
                        {booking.declaredPlayerCount === 1 ? 'Solo session' : 'Member + Companions'}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl p-5" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
                      <p className="text-[10px] tracking-[0.15em] uppercase mb-2" style={{ color: OLIVE_ACCENT }}>Accommodation</p>
                      <p className="text-white text-lg font-bold">{booking.resourceName}</p>
                      <p className="text-white/40 text-xs mt-0.5 capitalize">{booking.resourceType.replace(/_/g, ' ')}</p>
                    </div>
                    <div className="rounded-xl p-5" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
                      <p className="text-[10px] tracking-[0.15em] uppercase mb-2" style={{ color: OLIVE_ACCENT }}>Status</p>
                      {booking.unpaidFeeCents > 0 ? (
                        <>
                          <p className="text-amber-300 text-lg font-bold">${(booking.unpaidFeeCents / 100).toFixed(2)}</p>
                          <p className="text-white/40 text-xs mt-0.5">Fees outstanding</p>
                        </>
                      ) : (
                        <>
                          <p className="text-emerald-400 text-lg font-bold">Settled</p>
                          <p className="text-white/40 text-xs mt-0.5">All clear</p>
                        </>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <div className="rounded-xl p-6 flex items-center gap-4" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
                  <Icon name="self_improvement" className="text-3xl" style={{ color: OLIVE_ACCENT }} />
                  <div>
                    <p className="text-white font-medium" style={{ fontFamily: 'var(--font-headline)' }}>No upcoming reservations</p>
                    <p className="text-white/40 text-xs mt-1">Enjoy the house at your leisure. Walk-in visit recorded.</p>
                  </div>
                </div>
              )}
            </div>

            {booking && booking.unpaidFeeCents > 0 && booking.sessionId && (
              <div
                className="rounded-xl p-5 flex items-center justify-between animate-in fade-in slide-in-from-bottom-2 duration-500"
                style={{ background: 'rgba(139, 154, 107, 0.1)', border: `1px solid ${CARD_BORDER}` }}
              >
                <div className="flex items-center gap-3">
                  <Icon name="payment" className="text-xl" style={{ color: OLIVE_ACCENT }} />
                  <div>
                    <p className="text-white font-medium text-sm">Outstanding balance</p>
                    <p className="text-white/40 text-xs">Settle before your session for seamless entry</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowPaymentModal(true)}
                  className="tactile-btn px-6 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200"
                  style={{ background: OLIVE_ACCENT, color: '#1a220c' }}
                >
                  Pay Now
                </button>
              </div>
            )}
          </div>
        )}

        {state === 'already_checked_in' && checkinResult && (
          <div className="text-center animate-in fade-in zoom-in-95 duration-500 max-w-md">
            <p
              className="text-xs font-semibold tracking-[0.3em] uppercase mb-6"
              style={{ color: '#D4A844' }}
            >
              Already Registered
            </p>
            <h2
              className="text-4xl mb-3"
              style={{ fontFamily: 'var(--font-headline)', color: CREAM }}
            >
              Welcome back, <em>{firstName}</em>
            </h2>
            {checkinResult.memberName && (
              <p className="text-amber-300/80 text-lg mb-4">{checkinResult.memberName}</p>
            )}
            <p className="text-white/35 text-sm">Your arrival was recently noted. No further action required.</p>
          </div>
        )}

        {state === 'error' && (
          <div className="text-center animate-in fade-in zoom-in-95 duration-300 max-w-md">
            <p
              className="text-xs font-semibold tracking-[0.3em] uppercase mb-6"
              style={{ color: '#E57373' }}
            >
              Access Issue
            </p>
            <h2
              className="text-3xl mb-3"
              style={{ fontFamily: 'var(--font-headline)', color: CREAM }}
            >
              Unable to verify
            </h2>
            <p className="text-red-300/80 text-base mb-6">{errorMessage}</p>
            <p className="text-white/30 text-sm">Please see the concierge for assistance</p>
          </div>
        )}
      </div>

      <div className="relative pb-6 flex justify-center">
        <img
          src="/images/everclub-logo-light.webp"
          alt="Ever Club"
          className="h-4 opacity-10"
        />
      </div>

      {showPasscodeModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-[10000] animate-in fade-in duration-200">
          <div
            className="rounded-xl p-8 w-full max-w-sm mx-6 backdrop-blur-xl animate-in zoom-in-95 duration-300"
            style={{
              background: 'rgba(30,40,15,0.9)',
              border: `1px solid ${CARD_BORDER}`,
              boxShadow: '0 24px 48px rgba(0,0,0,0.5)'
            }}
          >
            <div className="text-center mb-8">
              <div
                className="w-14 h-14 rounded-xl flex items-center justify-center mx-auto mb-4"
                style={{ background: 'rgba(139, 154, 107, 0.1)', border: `1px solid ${CARD_BORDER}` }}
              >
                <Icon name="lock" className="text-3xl" style={{ color: OLIVE_ACCENT }} />
              </div>
              <h2 className="text-xl font-bold mb-1" style={{ fontFamily: 'var(--font-headline)', color: CREAM }}>Enter Passcode</h2>
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
                        ? 'border-[#8B9A6B]/50'
                        : 'border-white/15 focus:border-[#8B9A6B]/40'
                  } disabled:opacity-50`}
                  autoComplete="off"
                  style={{ WebkitTextSecurity: 'disc' } as React.CSSProperties}
                />
              ))}
            </div>

            {passcodeError && (
              <p className="text-red-400 text-sm text-center mb-4 animate-in fade-in duration-200">
                {passcodeErrorMessage || 'Incorrect passcode. Try again.'}
              </p>
            )}

            {passcodeChecking && (
              <div className="flex justify-center mb-4">
                <div className="w-6 h-6 rounded-full border-2 border-white/20 animate-spin" style={{ borderTopColor: OLIVE_ACCENT }} />
              </div>
            )}

            <button
              onClick={() => handlePasscodeSubmit(passcodeDigits)}
              disabled={passcodeChecking || passcodeDigits.some(d => !d)}
              className="w-full py-3 rounded-xl font-medium text-sm transition-all duration-200 disabled:opacity-30 mb-2"
              style={{ background: OLIVE_ACCENT, color: '#1a220c' }}
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
